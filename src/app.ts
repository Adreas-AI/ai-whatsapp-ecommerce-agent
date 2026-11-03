import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Services } from './container.js';
import { DEMO_CUSTOMERS, DEMO_ORDERS, DEMO_PRODUCTS, DEMO_SCENARIOS } from './demo/fixtures.js';
import { handleToolCall } from './http/tools.js';
import { bearerMatches, HttpError, readJson, readRawBody, send, sendJson } from './http/util.js';
import { MockCrmClient } from './integrations/crm.js';
import { UpstreamError } from './integrations/http.js';
import { MockWhatsAppClient } from './whatsapp/client.js';
import { buildTextMessagePayload } from './whatsapp/payloads.js';
import { signPayload } from './whatsapp/verify.js';

const PUBLIC_DIR = new URL('../public/', import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const simulateSchema = z
  .object({
    from: z.string().regex(/^\d{6,15}$/),
    name: z.string().max(80).optional(),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();

export interface App {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Background webhook processing still in flight (used for graceful shutdown). */
  inFlight: Set<Promise<void>>;
}

export function createApp(services: Services): App {
  const { config, gateway, traces, logger } = services;
  const inFlight = new Set<Promise<void>>();

  const track = (p: Promise<void>) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  function requireAdmin(req: IncomingMessage) {
    // DEMO_MODE has no real data; the server binds to 127.0.0.1 by default.
    if (config.demoMode) return;
    if (!bearerMatches(req, config.adminToken)) throw new HttpError(401, 'admin token required');
  }

  function requireDemo() {
    if (!config.demoMode) throw new HttpError(404, 'not found');
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // --- Meta webhook -------------------------------------------------------
    if (path === '/webhook') {
      if (method === 'GET') {
        const r = gateway.verifyChallenge(url.searchParams);
        return send(res, r.status, r.body, 'text/plain; charset=utf-8');
      }
      if (method === 'POST') {
        const raw = await readRawBody(req);
        const r = await gateway.receive(raw, req.headers['x-hub-signature-256']);
        track(r.processing);
        return sendJson(res, r.status, r.body);
      }
      throw new HttpError(405, 'method not allowed');
    }

    // --- Tool API for n8n ---------------------------------------------------
    if (path.startsWith('/tools/') && method === 'POST') {
      const body = await readJson(req);
      const result = await handleToolCall(services, req, path.slice('/tools/'.length), body);
      return sendJson(res, 200, result);
    }

    if (path === '/healthz' && method === 'GET') {
      return sendJson(res, 200, { ok: true, demo_mode: config.demoMode, orchestrator: config.orchestrator });
    }

    // --- Dashboard API --------------------------------------------------------
    if (path.startsWith('/api/')) {
      requireAdmin(req);
      if (path === '/api/status' && method === 'GET') {
        const label = (mock: boolean) => (mock ? 'mock (DEMO_MODE)' : 'live: configured, verify with the manual test procedure');
        return sendJson(res, 200, {
          demo_mode: config.demoMode,
          orchestrator: config.orchestrator,
          store_name: config.store.name,
          integrations: {
            whatsapp: label(services.whatsapp.mock),
            openai: services.classifier.mock ? 'mock rule classifier (DEMO_MODE)' : `live: ${config.openai.model}`,
            woocommerce: label(services.commerce.mock),
            hubspot: label(services.crm.mock),
            n8n: config.orchestrator === 'n8n' ? 'forwarding to n8n workflow' : 'not used (local orchestrator mirrors the workflow)',
          },
        });
      }
      if (path === '/api/turns' && method === 'GET') {
        return sendJson(res, 200, { turns: traces.list(Number(url.searchParams.get('limit') ?? 50)) });
      }
      if (path === '/api/crm' && method === 'GET') {
        requireDemo();
        const crm = services.crm;
        if (!(crm instanceof MockCrmClient)) return sendJson(res, 200, { contacts: [], tickets: [], operations: [] });
        return sendJson(res, 200, { mock: true, contacts: crm.contacts, tickets: crm.tickets, operations: crm.operations.slice(-30).reverse() });
      }
      if (path === '/api/demo/fixtures' && method === 'GET') {
        requireDemo();
        return sendJson(res, 200, {
          fictional: true,
          customers: DEMO_CUSTOMERS,
          scenarios: DEMO_SCENARIOS,
          products: DEMO_PRODUCTS.map((p) => ({ name: p.name, price: p.price, stock: p.stockStatus })),
          orders: DEMO_ORDERS.map((o) => ({ number: o.number, status: o.status, billingPhone: o.billingPhone, billingEmail: o.billingEmail })),
        });
      }
      if (path === '/api/demo/simulate' && method === 'POST') {
        requireDemo();
        const parsed = simulateSchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, 'invalid simulate request');
        const messageId = `wamid.DEMO.${randomUUID()}`;
        const payload = buildTextMessagePayload({
          ...parsed.data,
          messageId,
          phoneNumberId: config.meta.phoneNumberId ?? 'DEMO_PHONE_NUMBER_ID',
          timestampSec: Math.floor(services.now() / 1000),
        });
        // Goes through the exact same path as Meta traffic, including signature verification.
        const raw = Buffer.from(JSON.stringify(payload));
        const r = await gateway.receive(raw, signPayload(raw, config.meta.appSecret));
        await r.processing;
        return sendJson(res, r.status, { turn_id: messageId, ...r.body });
      }
      if (path === '/api/demo/reset' && method === 'POST') {
        requireDemo();
        services.store.clear();
        traces.clear();
        if (services.crm instanceof MockCrmClient) services.crm.reset();
        if (services.whatsapp instanceof MockWhatsAppClient) services.whatsapp.outbox = [];
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/api/admin/handoff/release' && method === 'POST') {
        const body = z.object({ wa_id: z.string().regex(/^\d{6,15}$/) }).strict().safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, 'wa_id required');
        return sendJson(res, 200, { released: await services.agent.releaseHandoff(body.data.wa_id) });
      }
      throw new HttpError(404, 'not found');
    }

    // --- Static dashboard -----------------------------------------------------
    const file = STATIC_FILES[path];
    if (file && method === 'GET') {
      const content = await readFile(new URL(file.file, PUBLIC_DIR));
      return send(res, 200, content, file.type, file.type.startsWith('text/html') ? { 'content-security-policy': CSP } : {});
    }
    throw new HttpError(404, 'not found');
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof UpstreamError) {
        logger.error('upstream error in request', { service: err.service, status: err.status });
        return sendJson(res, 502, { error: `${err.service} unavailable` });
      }
      logger.error('unhandled request error', { error: err });
      sendJson(res, 500, { error: 'internal error' });
    });
  };

  return { handler, inFlight };
}
