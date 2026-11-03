import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SECRETS } from '../src/config.js';
import { createTurnToken, verifyTurnToken } from '../src/security/turnToken.js';
import { makeHarness, startServer, type Harness } from './helpers.js';

/**
 * Exercises the gateway tool API the way the n8n workflow does, including the
 * security properties n8n relies on.
 */
/** Loose shape of tool responses, for assertions only. */
interface ToolJson {
  handoff_active?: boolean;
  classification?: unknown;
  route?: string;
  order_number?: string;
  outcome?: string;
  reply_text?: string;
  delivery?: string;
  guard_notes: string[];
}
const body = async (res: Response | Promise<Response>) => (await (await res).json()) as ToolJson;

describe('tool API for n8n', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function setup(waId = '15550100001', text = 'Where is my order #1002?') {
    const h = makeHarness({ ORCHESTRATOR: 'n8n', N8N_INBOUND_WEBHOOK_URL: 'http://n8n.invalid/webhook/x' });
    const forwarded: Record<string, unknown>[] = [];
    // Capture what the gateway would send to n8n.
    (h.gateway as unknown as { forwardToN8n: (t: unknown) => Promise<void> }).forwardToN8n = async (turn) => {
      forwarded.push(h.gateway.buildN8nEnvelope(turn as never));
    };
    const srv = await startServer(h);
    close = srv.close;
    await h.say(waId, text);
    const envelope = forwarded[0]!;
    const call = (tool: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${srv.url}/tools/${tool}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${DEMO_SECRETS.toolsApiToken}`,
          'x-turn-token': envelope.turn_token as string,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    return { h, envelope, call };
  }

  it('the n8n envelope is redacted and carries no email or full phone number', async () => {
    const { envelope } = await setup('15550100099', 'order 1001, my email is alex.rivera@example.com, phone +1 555 010 0001');
    const json = JSON.stringify(envelope);
    expect(json).not.toContain('alex.rivera@example.com');
    expect(json).not.toContain('15550100099');
    expect(json).not.toContain('555 010 0001');
    expect(envelope.text_redacted).toContain('[EMAIL]');
    expect(envelope.entities).toEqual({ order_number: '1001', has_email: true });
  });

  it('runs the full n8n tool sequence and produces a grounded reply', async () => {
    const { h, call } = await setup();
    expect((await body(call('context', {}))).handoff_active).toBe(false);
    expect((await call('crm/upsert-contact', {})).status).toBe(200);
    const { classification } = await body(call('classify/rules', { source: 'mock' }));
    const route = await body(call('route', { classification, source: 'mock' }));
    expect(route).toMatchObject({ route: 'order_lookup', order_number: '1002' });
    const lookup = await body(call('orders/lookup', { order_number: route.order_number }));
    expect(lookup.outcome).toBe('verified');
    expect(lookup).not.toHaveProperty('order'); // raw order data never leaves the gateway
    const sent = await body(call('whatsapp/reply', { text: lookup.reply_text }));
    expect(sent.delivery).toBe('mock_not_sent');
    expect((await call('turn/complete', { status: 'done' })).status).toBe(200);
    expect(h.traces.list()[0]!.status).toBe('done');
  });

  it('requires the tools bearer token', async () => {
    const { call } = await setup();
    expect((await call('context', {}, { authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('requires a valid, unexpired turn token', async () => {
    const { h, call } = await setup();
    expect((await call('context', {}, { 'x-turn-token': 'forged.token' })).status).toBe(403);
    const otherSecret = createTurnToken({ messageId: 'x', waId: '15550100002' }, 'not-the-secret', 60_000, h.clock.t);
    expect((await call('context', {}, { 'x-turn-token': otherSecret })).status).toBe(403);
    h.clock.advance(2 * 60 * 60 * 1000);
    expect((await call('context', {})).status).toBe(403);
  });

  it('rejects attempts to choose the customer or extra fields in the body', async () => {
    const { call } = await setup();
    const res = await call('orders/lookup', { order_number: '1003', wa_id: '15550100002' });
    expect(res.status).toBe(400);
    expect((await call('orders/lookup', { order_number: '1003; DROP TABLE' })).status).toBe(400);
    expect((await call('whatsapp/reply', { text: 'hi', to: '15559999999' })).status).toBe(400);
  });

  it('rejects unknown tools', async () => {
    const { call } = await setup();
    expect((await call('orders/list-all', {})).status).toBe(404);
  });

  it('server guard validates arbitrary model output', async () => {
    const { call } = await setup();
    const res = await body(call('route', { classification: { intent: 'delete_all_orders', confidence: 2 }, source: 'openai' }));
    expect(res.route).toBe('reply');
    expect(res.guard_notes.join(' ')).toContain('schema validation');
  });

  it('turn tokens are bound to one message and customer', () => {
    const t = createTurnToken({ messageId: 'm1', waId: '15550100001' }, 's'.repeat(32), 1000, 0);
    expect(verifyTurnToken(t, 's'.repeat(32), 10)).toEqual({ messageId: 'm1', waId: '15550100001', exp: 1000 });
    const [payload, sig] = t.split('.');
    const tampered = Buffer.from(JSON.stringify({ mid: 'm1', wa: '15550100002', exp: 1000 })).toString('base64url');
    expect(verifyTurnToken(`${tampered}.${sig}`, 's'.repeat(32), 10)).toBeNull();
    expect(verifyTurnToken(`${payload}.${sig}`, 's'.repeat(32), 2000)).toBeNull();
  });
});

export type { Harness };
