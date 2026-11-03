import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createServices, type ServiceOverrides, type Services } from '../src/container.js';
import { MockCommerceClient } from '../src/integrations/commerce.js';
import { MockCrmClient } from '../src/integrations/crm.js';
import { silentLogger } from '../src/observability/logger.js';
import { MockWhatsAppClient } from '../src/whatsapp/client.js';
import { buildTextMessagePayload } from '../src/whatsapp/payloads.js';
import { signPayload } from '../src/whatsapp/verify.js';

/** Fixture timestamps are 1793750400 (2026-11-04T00:00:00Z); tests run one minute later. */
export const FIXTURE_TS_SEC = 1793750400;

export function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
}

export class TestClock {
  constructor(public t = FIXTURE_TS_SEC * 1000 + 60_000) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface Harness extends Services {
  clock: TestClock;
  crmMock: MockCrmClient;
  waMock: MockWhatsAppClient;
  commerceMock: MockCommerceClient;
  /** Delivers a signed text message through the real gateway and waits for processing. */
  say(from: string, text: string, opts?: { name?: string; messageId?: string }): Promise<{ status: number; messageId: string }>;
  lastReply(): string | undefined;
}

let seq = 0;

export function makeHarness(env: Record<string, string> = {}, overrides: ServiceOverrides = {}): Harness {
  const clock = new TestClock();
  const config: Config = loadConfig({ DEMO_MODE: 'true', LOG_LEVEL: 'silent', ...env });
  const crmMock = new MockCrmClient(clock.now);
  const waMock = new MockWhatsAppClient(clock.now);
  const commerceMock = new MockCommerceClient();
  const services = createServices(config, {
    now: clock.now,
    logger: silentLogger,
    crm: crmMock,
    whatsapp: waMock,
    commerce: commerceMock,
    ...overrides,
  });

  return {
    ...services,
    clock,
    crmMock,
    waMock,
    commerceMock,
    async say(from, text, opts = {}) {
      const messageId = opts.messageId ?? `wamid.TEST.${++seq}`;
      const raw = Buffer.from(
        JSON.stringify(
          buildTextMessagePayload({
            from,
            name: opts.name ?? 'Test Customer (fictional)',
            text,
            messageId,
            phoneNumberId: 'DEMO_PHONE_NUMBER_ID',
            timestampSec: Math.floor(clock.t / 1000),
          }),
        ),
      );
      const r = await services.gateway.receive(raw, signPayload(raw, config.meta.appSecret));
      await r.processing;
      return { status: r.status, messageId };
    },
    lastReply() {
      return waMock.outbox.at(-1)?.body;
    },
  };
}

export async function startServer(services: Services): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const app = createApp(services);
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      await Promise.allSettled([...app.inFlight]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Waits until background webhook processing (started by an HTTP POST) has settled. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
