import { describe, expect, it } from 'vitest';
import { ContactService } from '../src/agent/contacts.js';
import { MockCrmClient } from '../src/integrations/crm.js';
import { silentLogger } from '../src/observability/logger.js';
import { MemoryStore } from '../src/store/kv.js';
import { makeHarness } from './helpers.js';

function setup() {
  const crm = new MockCrmClient();
  const store = new MemoryStore();
  return { crm, store, service: new ContactService(crm, store, 3_600_000, silentLogger) };
}

describe('HubSpot contact de-duplication', () => {
  it('creates exactly one contact for concurrent messages, even with search index lag', async () => {
    const { crm, service } = setup();
    crm.searchIndexLagMs = 60_000; // newly created contacts are not searchable yet
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.upsertFromWhatsApp({ waId: '15550100001', profileName: 'Alex' })),
    );
    expect(crm.contacts).toHaveLength(1);
    expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
    expect(results.filter((r) => r.action === 'created')).toHaveLength(1);
  });

  it('matches an existing contact stored with +E.164 phone', async () => {
    const { crm, service } = setup();
    const existing = await crm.createContact({ phone: '+15550100001', firstname: 'Alex', email: 'alex.rivera@example.com' });
    const r = await service.upsertFromWhatsApp({ waId: '15550100001', profileName: 'WhatsApp name' });
    expect(r.contact.id).toBe(existing.id);
    expect(r.action).toBe('matched');
    expect(crm.contacts).toHaveLength(1);
  });

  it('matches a contact whose number is stored in mobilephone without "+"', async () => {
    const { crm, service } = setup();
    const existing = await crm.createContact({});
    crm.contacts[0]!.mobilephone = '15550100001';
    const r = await service.upsertFromWhatsApp({ waId: '15550100001', profileName: null });
    expect(r.contact.id).toBe(existing.id);
    expect(crm.contacts).toHaveLength(1);
  });

  it('never overwrites curated CRM fields, only fills empty ones', async () => {
    const { crm, service } = setup();
    await crm.createContact({ phone: '+15550100001', firstname: 'Alexandra', email: 'curated@example.com' });
    const r = await service.upsertFromWhatsApp({ waId: '15550100001', profileName: 'alex 🌿', verifiedEmail: 'other@example.com' });
    expect(r.action).toBe('matched');
    expect(crm.contacts[0]!.firstname).toBe('Alexandra');
    expect(crm.contacts[0]!.email).toBe('curated@example.com');
  });

  it('attaches a verified email when the contact has none', async () => {
    const { crm, service } = setup();
    await crm.createContact({ phone: '+15550100001' });
    const r = await service.upsertFromWhatsApp({ waId: '15550100001', profileName: null, verifiedEmail: 'alex.rivera@example.com' });
    expect(r.action).toBe('updated');
    expect(r.changes).toEqual(['email']);
  });

  it('picks the oldest phone match when the CRM already contains duplicates', async () => {
    const { crm, service } = setup();
    const first = await crm.createContact({ phone: '+15550100001' });
    crm.contacts[0]!.createdAt = '2025-01-01T00:00:00Z';
    await crm.createContact({ phone: '+15550100001' });
    const r = await service.upsertFromWhatsApp({ waId: '15550100001', profileName: null });
    expect(r.contact.id).toBe(first.id);
    expect(r.duplicatesFound).toBe(1);
    expect(crm.contacts).toHaveLength(2); // never deletes or merges automatically
  });

  it('does not use an email typed in chat to match someone else’s contact', async () => {
    const h = makeHarness();
    const victim = await h.crmMock.createContact({ phone: '+15550100002', email: 'sam.chen@example.net' });
    await h.say('15550100099', 'my email is sam.chen@example.net, any news?');
    expect(h.crmMock.contacts).toHaveLength(2);
    const victimNow = h.crmMock.contacts.find((c) => c.id === victim.id)!;
    expect(victimNow.phone).toBe('+15550100002');
    const created = h.crmMock.contacts.find((c) => c.id !== victim.id)!;
    expect(created.email).toBeNull();
  });

  it('reuses the cached contact id across turns without searching again', async () => {
    const h = makeHarness();
    await h.say('15550100001', 'hello');
    await h.say('15550100001', 'hello again');
    expect(h.crmMock.operations.filter((o) => o.op === 'search')).toHaveLength(1);
    expect(h.crmMock.contacts).toHaveLength(1);
  });
});
