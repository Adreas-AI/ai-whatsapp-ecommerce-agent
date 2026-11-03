import { describe, expect, it } from 'vitest';
import { normalizePhoneDigits, phoneMatchesWaId } from '../src/agent/orders.js';
import { decideRoute } from '../src/agent/router.js';
import { makeHarness } from './helpers.js';

const ALEX = '15550100001'; // owns 1001 and 1002 (fictional)
const SAM = '15550100002'; // owns 1003 (fictional)
const STRANGER = '15550100099';

const PRIVATE_BITS = ['alex.rivera@example.com', 'sam.chen@example.net', '555', 'Bamboo Desk Organizer', 'Terracotta', 'On hold', 'Processing'];

function expectNoOrderDetails(reply: string | undefined) {
  expect(reply).toBeDefined();
  for (const bit of PRIVATE_BITS) expect(reply).not.toContain(bit);
}

describe('order ownership verification', () => {
  it('returns order details when the WhatsApp number matches the billing phone (national format normalised)', async () => {
    const h = makeHarness();
    await h.say(ALEX, 'Where is my order #1002?');
    const reply = h.lastReply()!;
    expect(reply).toContain('Order #1002 (verified ✅)');
    expect(reply).toContain('DP000000042GR');
    expect(reply).toContain('2026-10-27 (as provided by the store)');
    expect(h.traces.list()[0]!.orderLookup?.order?.verifiedBy).toBe('whatsapp_phone');
  });

  it('never reveals someone else’s order just because the order number is known', async () => {
    const h = makeHarness();
    await h.say(ALEX, 'status of order 1003 please');
    expect(h.lastReply()).toContain('email address used for order #1003');
    expectNoOrderDetails(h.lastReply());
  });

  it('refuses with a uniform message when the email does not match', async () => {
    const h = makeHarness();
    await h.say(ALEX, 'status of order 1003 please');
    await h.say(ALEX, 'alex.rivera@example.com');
    const wrongEmail = h.lastReply()!;
    expect(wrongEmail).toContain("couldn't verify an order with those details");
    expectNoOrderDetails(wrongEmail);
    expect(h.traces.list()[0]!.orderLookup?.outcome).toBe('not_verified');
  });

  it('gives the same answers for a non-existent order as for someone else’s order (no enumeration oracle)', async () => {
    const a = makeHarness();
    await a.say(STRANGER, 'order 1003 status');
    const askExisting = a.lastReply();
    await a.say(STRANGER, 'wrong@example.com');
    const failExisting = a.lastReply();

    const b = makeHarness();
    await b.say(STRANGER, 'order 9999 status');
    const askMissing = b.lastReply()!.replace('9999', '1003');
    await b.say(STRANGER, 'wrong@example.com');
    const failMissing = b.lastReply();

    expect(askMissing).toBe(askExisting);
    expect(failMissing).toBe(failExisting);
  });

  it('verifies by email from an unknown number and then remembers the verification', async () => {
    const h = makeHarness();
    await h.say(STRANGER, 'What is the status of order 1001?');
    expect(h.lastReply()).toContain('email address used for order #1001');
    await h.say(STRANGER, 'Alex.Rivera@Example.com');
    expect(h.lastReply()).toContain('Order #1001 (verified ✅)');
    expect(h.lastReply()).toContain("Estimated delivery: not available yet. I won't guess a date");
    await h.say(STRANGER, 'and order 1001 again?');
    expect(h.traces.list()[0]!.orderLookup?.order?.verifiedBy).toBe('earlier_in_conversation');
  });

  it('locks lookups after repeated failures and escalates to a human', async () => {
    const h = makeHarness({ ORDER_VERIFICATION_MAX_FAILURES: '3' });
    await h.say(STRANGER, 'order 1003');
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) await h.say(STRANGER, email);
    expect(h.lastReply()).toContain('paused order lookups');
    expect(h.crmMock.tickets).toHaveLength(1);
    expect(h.crmMock.tickets[0]!.priority).toBe('HIGH');
    // Correct email afterwards still gets nothing: the bot is muted by the handoff.
    const before = h.waMock.outbox.length;
    await h.say(STRANGER, 'sam.chen@example.net');
    expect(h.waMock.outbox.length).toBe(before);
  });

  it('rate-limits one order number across many chats (targeted guessing)', async () => {
    const h = makeHarness({ ORDER_VERIFICATION_MAX_FAILURES: '2' });
    for (let i = 0; i < 4; i++) {
      const wa = `1555010020${i}`;
      await h.say(wa, 'order 1003');
      await h.say(wa, `guess${i}@example.com`);
    }
    const r = await h.agent.orders.lookup({ waId: '15550100300', orderNumber: '1003', email: 'sam.chen@example.net', previouslyVerified: false });
    expect(r.outcome).toBe('locked');
  });

  it('discards an order number the model invented (not present in the message)', () => {
    const d = decideRoute({
      classification: { intent: 'order_status', confidence: 0.95, product_query: null, order_number: '1003', wants_human: false, sentiment: 'neutral' },
      rawText: 'where is my order?',
      messageType: 'text',
      entities: {},
      state: { lowConfidenceStreak: 0 },
      minConfidence: 0.55,
    });
    expect(d.route).toBe('reply');
    expect(d.replyKey).toBe('ask_order_number');
    expect(d.guardNotes.join(' ')).toContain('discarded model order_number');
  });

  it('normalises billing phone formats conservatively', () => {
    expect(normalizePhoneDigits('+1 555 010 0001')).toBe('15550100001');
    expect(normalizePhoneDigits('0015550100001')).toBe('15550100001');
    expect(normalizePhoneDigits('(555) 010-0001', '1')).toBe('15550100001');
    expect(normalizePhoneDigits('069 1234 5678', '30')).toBe('306912345678');
    expect(normalizePhoneDigits('12')).toBeNull();
    expect(phoneMatchesWaId('(555) 010-0001', ALEX)).toBe(false); // no default country code → no guessing
    expect(phoneMatchesWaId('+15550100002', ALEX)).toBe(false);
    expect(phoneMatchesWaId(null, ALEX)).toBe(false);
  });

  it('Sam can read their own order by phone', async () => {
    const h = makeHarness();
    await h.say(SAM, 'order #1003 status?');
    expect(h.lastReply()).toContain('On hold: our team needs to review it');
  });
});
