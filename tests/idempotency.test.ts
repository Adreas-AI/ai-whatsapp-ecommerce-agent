import { describe, expect, it } from 'vitest';
import { DEMO_SECRETS } from '../src/config.js';
import { parseWebhookPayload } from '../src/whatsapp/parse.js';
import { signPayload } from '../src/whatsapp/verify.js';
import { fixture, makeHarness } from './helpers.js';

const raw = Buffer.from(fixture('meta/text-message.json'));
const sig = signPayload(raw, DEMO_SECRETS.appSecret);

describe('duplicate message handling (idempotency)', () => {
  it('processes a redelivered webhook only once', async () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) await (await h.gateway.receive(raw, sig)).processing;
    expect(h.waMock.outbox).toHaveLength(1);
    expect(h.crmMock.contacts).toHaveLength(1);
    const trace = h.traces.get('wamid.FIXTURE.TEXT.0001')!;
    expect(trace.toolCalls.filter((c) => c.name === 'gateway.dedupe')).toHaveLength(2);
  });

  it('processes concurrent duplicate deliveries only once', async () => {
    const h = makeHarness();
    const results = await Promise.all([h.gateway.receive(raw, sig), h.gateway.receive(raw, sig), h.gateway.receive(raw, sig)]);
    await Promise.all(results.map((r) => r.processing));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(h.waMock.outbox).toHaveLength(1);
  });

  it('sends at most one reply per inbound message even if the reply tool is retried', async () => {
    const h = makeHarness();
    await h.say('15550100001', 'hello', { messageId: 'wamid.TEST.REPLY' });
    const turn = (await h.agent.loadTurn('wamid.TEST.REPLY'))!;
    const again = await h.agent.sendReply(turn, 'second attempt');
    expect(again.delivery).toBe('duplicate_suppressed');
    expect(h.waMock.outbox).toHaveLength(1);
  });

  it('allows a retry when the first send definitely failed upstream', async () => {
    const h = makeHarness();
    const { UpstreamError } = await import('../src/integrations/http.js');
    h.waMock.failNext = new UpstreamError('whatsapp', 400, 'HTTP 400', false);
    await h.say('15550100001', 'hello', { messageId: 'wamid.TEST.RETRY' });
    expect(h.waMock.outbox).toHaveLength(0);
    const turn = (await h.agent.loadTurn('wamid.TEST.RETRY'))!;
    expect((await h.agent.sendReply(turn, 'retry')).delivery).toBe('mock_not_sent');
    expect(h.waMock.outbox).toHaveLength(1);
  });

  it('keeps the idempotency key after a network error (message may have been sent)', async () => {
    const h = makeHarness();
    const { UpstreamError } = await import('../src/integrations/http.js');
    h.waMock.failNext = new UpstreamError('whatsapp', null, 'network TimeoutError', false);
    await h.say('15550100001', 'hello', { messageId: 'wamid.TEST.NET' });
    const turn = (await h.agent.loadTurn('wamid.TEST.NET'))!;
    expect((await h.agent.sendReply(turn, 'retry')).delivery).toBe('duplicate_suppressed');
  });

  it('treats different message ids from the same customer as separate turns', async () => {
    const h = makeHarness();
    await h.say('15550100001', 'hello');
    await h.say('15550100001', 'hello');
    expect(h.waMock.outbox).toHaveLength(2);
  });

  it('dedupe entries expire after DEDUPE_TTL_HOURS', async () => {
    const h = makeHarness({ DEDUPE_TTL_HOURS: '1' });
    await (await h.gateway.receive(raw, sig)).processing;
    h.clock.advance(2 * 3_600_000);
    // Message is now older than 1h but well within 24h; it is reprocessed because its dedupe key expired.
    await (await h.gateway.receive(raw, sig)).processing;
    expect(h.waMock.outbox).toHaveLength(2);
  });

  it('parses batched deliveries and skips malformed messages', () => {
    const parsed = parseWebhookPayload(JSON.parse(fixture('meta/batched-messages.json')));
    expect(parsed.messages.map((m) => m.messageId)).toEqual(['wamid.FIXTURE.BATCH.0001', 'wamid.FIXTURE.BATCH.0002']);
    expect(parsed.messages[1]!.text).toBe('Talk to an agent');
    expect(parsed.skipped).toBe(1);
  });
});
