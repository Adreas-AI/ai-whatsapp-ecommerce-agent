import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/integrations/http.js';
import { makeHarness } from './helpers.js';

const SAM = '15550100002';

describe('human escalation paths', () => {
  it('creates a ticket linked to the contact when the customer asks for a person', async () => {
    const h = makeHarness();
    await h.say(SAM, 'Can I talk to a real person please?');
    expect(h.crmMock.tickets).toHaveLength(1);
    const ticket = h.crmMock.tickets[0]!;
    expect(ticket.contactId).toBe(h.crmMock.contacts[0]!.id);
    expect(ticket.subject).toContain('customer request');
    expect(h.lastReply()).toContain(`ticket ${ticket.id}`);
  });

  it('escalates complaints with HIGH priority', async () => {
    const h = makeHarness();
    await h.say(SAM, 'My planter arrived cracked, I want a refund');
    expect(h.crmMock.tickets[0]!.priority).toBe('HIGH');
    expect(h.traces.list()[0]!.route?.route).toBe('escalate');
  });

  it('keeps tickets separate from deals: no deal operation exists or is called', async () => {
    const h = makeHarness();
    await h.say(SAM, 'I need a human');
    expect(h.crmMock.operations.map((o) => o.op)).not.toContain('create_deal');
    expect(Object.keys(h.crmMock)).not.toContain('createDeal');
  });

  it('mutes the bot after handoff and does not create duplicate tickets', async () => {
    const h = makeHarness();
    await h.say(SAM, 'agent please');
    const replies = h.waMock.outbox.length;
    await h.say(SAM, 'hello? anyone?');
    await h.say(SAM, 'I want a human!!');
    expect(h.waMock.outbox.length).toBe(replies);
    expect(h.crmMock.tickets).toHaveLength(1);
    expect(h.traces.list()[0]!.route?.route).toBe('none');
  });

  it('resumes automated replies after an agent releases the handoff', async () => {
    const h = makeHarness();
    await h.say(SAM, 'agent please');
    expect(await h.agent.releaseHandoff(SAM)).toBe(true);
    await h.say(SAM, 'hi');
    expect(h.lastReply()).toContain('How can I help?');
  });

  it('escalates after two low-confidence messages in a row', async () => {
    const h = makeHarness();
    await h.say(SAM, 'blorp');
    expect(h.lastReply()).toContain("didn't quite catch that");
    expect(h.crmMock.tickets).toHaveLength(0);
    await h.say(SAM, 'zzzq');
    expect(h.crmMock.tickets).toHaveLength(1);
    expect(h.traces.list()[0]!.route?.reason).toContain('twice in a row');
  });

  it('escalates once with an honest message when a tool fails (no retry loop)', async () => {
    const h = makeHarness();
    h.commerceMock.failNext = new UpstreamError('woocommerce', 503, 'HTTP 503', true);
    await h.say(SAM, 'Do you have the linen throw in stock?');
    expect(h.lastReply()).toContain('technical problem');
    expect(h.crmMock.tickets).toHaveLength(1);
    expect(h.crmMock.tickets[0]!.subject).toContain('tool error');
    expect(h.waMock.outbox).toHaveLength(1);
  });

  it('tells the customer the fallback email if the ticket cannot be created', async () => {
    const h = makeHarness({ SUPPORT_EMAIL: 'help@demo-store.example' });
    h.crmMock.failNext.create_ticket = new UpstreamError('hubspot', 500, 'HTTP 500', false);
    await h.say(SAM, 'I want to speak to a manager');
    expect(h.lastReply()).toContain('help@demo-store.example');
    expect(h.crmMock.tickets).toHaveLength(0);
    // Still in handoff: a human is needed even though the ticket failed.
    expect((await h.agent.conversations.get(SAM)).handoff?.active).toBe(true);
  });

  it('answers even when the CRM is down for the contact upsert', async () => {
    const h = makeHarness();
    h.crmMock.failNext.search = new UpstreamError('hubspot', 503, 'HTTP 503', true);
    await h.say(SAM, 'Do you have the linen throw in stock?');
    expect(h.lastReply()).toContain('Linen Throw Blanket – Sage');
  });

  it('ticket content is redacted and contains no raw email or phone', async () => {
    const h = makeHarness();
    const spy: string[] = [];
    const original = h.crmMock.createTicket.bind(h.crmMock);
    h.crmMock.createTicket = async (input) => {
      spy.push(input.content);
      return original(input);
    };
    await h.say(SAM, 'I need a person, call me on +1 555 010 0002 or sam.chen@example.net');
    expect(spy[0]).toContain('[PHONE]');
    expect(spy[0]).toContain('[EMAIL]');
    expect(spy[0]).not.toContain('sam.chen@example.net');
    expect(spy[0]).not.toContain('15550100002');
  });
});
