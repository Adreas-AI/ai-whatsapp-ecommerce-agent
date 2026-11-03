import { describe, expect, it } from 'vitest';
import { createLogger, sanitizeFields } from '../src/observability/logger.js';
import { extractEmail, extractOrderNumber, maskPhone, redactText, sanitizeUpstreamText } from '../src/security/redact.js';
import { decideOutbound, SERVICE_WINDOW_MS } from '../src/whatsapp/window.js';
import { makeHarness } from './helpers.js';

describe('WhatsApp 24-hour customer service window', () => {
  const now = 1_800_000_000_000;
  const base = { now, templateLanguage: 'en_US' } as const;

  it('allows free-form replies inside the window', () => {
    expect(decideOutbound({ ...base, lastInboundAt: now - 1000, purpose: 'bot_reply' })).toEqual({ kind: 'text' });
  });

  it('blocks bot replies outside the window', () => {
    expect(decideOutbound({ ...base, lastInboundAt: now - SERVICE_WINDOW_MS - 1, purpose: 'bot_reply' })).toEqual({ kind: 'blocked', reason: 'window_closed' });
  });

  it('requires an approved template for agent follow-ups outside the window', () => {
    expect(decideOutbound({ ...base, lastInboundAt: now - SERVICE_WINDOW_MS - 1, purpose: 'agent_followup' }).kind).toBe('blocked');
    expect(decideOutbound({ ...base, lastInboundAt: now - SERVICE_WINDOW_MS - 1, purpose: 'agent_followup', templateName: 'order_followup' })).toEqual({
      kind: 'template',
      name: 'order_followup',
      language: 'en_US',
    });
  });

  it('never messages a number that has not contacted the business (no unsolicited messages)', () => {
    expect(decideOutbound({ ...base, lastInboundAt: undefined, purpose: 'agent_followup', templateName: 't' })).toEqual({
      kind: 'blocked',
      reason: 'no_prior_customer_message',
    });
  });

  it('does not answer a stale (>24h) redelivered message', async () => {
    const h = makeHarness();
    h.clock.advance(SERVICE_WINDOW_MS + 60_000);
    const { buildTextMessagePayload } = await import('../src/whatsapp/payloads.js');
    const { signPayload } = await import('../src/whatsapp/verify.js');
    const raw = Buffer.from(
      JSON.stringify(buildTextMessagePayload({ from: '15550100001', text: 'hi', messageId: 'wamid.OLD', phoneNumberId: 'x', timestampSec: 1793750400 })),
    );
    await (await h.gateway.receive(raw, signPayload(raw, h.config.meta.appSecret))).processing;
    expect(h.waMock.outbox).toHaveLength(0);
  });

  it('a delayed reply is blocked if the window closed while processing', async () => {
    const h = makeHarness();
    await h.say('15550100001', 'hi', { messageId: 'wamid.SLOW' });
    const turn = (await h.agent.loadTurn('wamid.SLOW'))!;
    await h.store.delete('reply:wamid.SLOW');
    h.clock.advance(SERVICE_WINDOW_MS + 1);
    expect(await h.agent.sendReply(turn, 'late')).toEqual({ delivery: 'blocked', reason: 'window_closed' });
  });

  it('agent follow-up uses the template outside the window', async () => {
    const h = makeHarness({ WHATSAPP_FOLLOWUP_TEMPLATE_NAME: 'support_followup' });
    await h.say('15550100001', 'hi');
    h.clock.advance(SERVICE_WINDOW_MS + 1);
    expect(await h.agent.sendAgentFollowup('15550100001', 'Any update?')).toEqual({ delivery: 'template support_followup' });
    expect(await h.agent.sendAgentFollowup('15550100777', 'cold outreach')).toEqual({ delivery: 'blocked: no_prior_customer_message' });
  });
});

describe('PII minimisation', () => {
  it('redacts emails, phone numbers and card-like numbers but keeps order numbers', () => {
    const out = redactText('Order #1002, email a.b@example.com, phone +30 691 234 5678, card 4111 1111 1111 1111');
    expect(out).toBe('Order #1002, email [EMAIL], phone [PHONE], card [CARD_OR_ID]');
  });

  it('extracts order numbers and emails', () => {
    expect(extractOrderNumber('Where is my order #1002?')).toBe('1002');
    expect(extractOrderNumber('status of order number: 55512')).toBe('55512');
    expect(extractOrderNumber('1002')).toBeUndefined();
    expect(extractOrderNumber('1002', true)).toBe('1002');
    expect(extractOrderNumber('I have 2 kids')).toBeUndefined();
    expect(extractEmail('Mail: Alex.Rivera@Example.COM.')).toBe('alex.rivera@example.com');
  });

  it('masks identifiers', () => {
    expect(maskPhone('15550100001')).toBe('1555*****01');
  });

  it('logger redacts secrets, phones, emails and message text', () => {
    const lines: string[] = [];
    const log = createLogger('info', { write: (l) => lines.push(l) });
    log.info('x', { authorization: 'Bearer abc', waId: '15550100001', email: 'a@example.com', text: 'my card 4111 1111 1111 1111', nested: { apiKey: 'sk-1' } });
    const rec = JSON.parse(lines[0]!);
    expect(rec.authorization).toBe('[REDACTED]');
    expect(rec.waId).toBe('1555*****01');
    expect(rec.email).toBe('a***@example.com');
    expect(rec.text).toBe('[27 chars]');
    expect(rec.nested.apiKey).toBe('[REDACTED]');
    expect(sanitizeFields({ text: 'mail a@example.com' }, true)).toEqual({ text: 'mail [EMAIL]' });
  });

  it('sanitises untrusted upstream text (HTML, control chars, length)', () => {
    expect(sanitizeUpstreamText('<p>Nice&nbsp;<b>linen</b></p>\u0007<script>x</script>')).toBe('Nice linen x');
    expect(sanitizeUpstreamText('a'.repeat(300), 10)).toHaveLength(10);
    expect(sanitizeUpstreamText(42)).toBe('');
  });

  it('live-mode traces store redacted text and masked numbers only', async () => {
    const h = makeHarness();
    // Simulate live-mode trace settings on an otherwise demo harness.
    (h.config as { demoMode: boolean }).demoMode = false;
    await h.say('15550100001', 'my email is a@example.com');
    const t = h.traces.list()[0]!;
    expect(t.inboundText).toBe('my email is [EMAIL]');
    expect(t.waIdDisplay).toBe('1555*****01');
    expect(t.profileName).toBeNull();
  });
});
