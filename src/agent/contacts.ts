import type { CrmClient, CrmContact } from '../integrations/crm.js';
import type { Logger } from '../observability/logger.js';
import { KeyedMutex, type KeyValueStore } from '../store/kv.js';

/**
 * HubSpot contact upsert with de-duplication.
 *
 * Duplicates usually come from (a) concurrent messages from the same person and
 * (b) HubSpot search indexing lag right after a create. We guard against both:
 *  - a per-wa_id mutex serialises upserts for the same customer;
 *  - a local wa_id → contactId cache is consulted before searching.
 * Matching is by phone (the WhatsApp number). An email typed into the chat is
 * NOT used to match or merge records, because anyone can type anyone's email.
 * Email is only attached after it passed order-ownership verification.
 */

export type UpsertAction = 'created' | 'updated' | 'matched';

export interface UpsertResult {
  contact: CrmContact;
  action: UpsertAction;
  duplicatesFound: number;
  changes: string[];
}

export function phoneVariants(waId: string): string[] {
  return [`+${waId}`, waId];
}

export class ContactService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly crm: CrmClient,
    private readonly store: KeyValueStore,
    private readonly cacheTtlMs: number,
    private readonly logger: Logger,
  ) {}

  async upsertFromWhatsApp(input: { waId: string; profileName: string | null; verifiedEmail?: string }): Promise<UpsertResult> {
    return this.mutex.run(input.waId, async () => {
      const cacheKey = `crm:contact:${input.waId}`;
      const cached = await this.store.get<CrmContact>(cacheKey);

      let candidates: CrmContact[];
      if (cached) {
        candidates = [cached];
      } else {
        candidates = await this.crm.searchContacts({ phones: phoneVariants(input.waId), email: input.verifiedEmail });
      }

      if (candidates.length > 1) {
        this.logger.warn('crm duplicate contacts detected; using oldest phone match', { count: candidates.length });
      }
      const phones = new Set(phoneVariants(input.waId));
      const existing =
        [...candidates]
          .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
          .find((c) => phones.has(c.phone ?? '') || phones.has(c.mobilephone ?? '')) ?? candidates[0];

      let result: UpsertResult;
      if (!existing) {
        const contact = await this.crm.createContact({
          phone: `+${input.waId}`,
          firstname: input.profileName ?? undefined,
          email: input.verifiedEmail,
        });
        result = { contact, action: 'created', duplicatesFound: 0, changes: ['phone', ...(input.profileName ? ['firstname'] : []), ...(input.verifiedEmail ? ['email'] : [])] };
      } else {
        // Only fill empty fields. Never overwrite data a human may have curated in the CRM.
        const patch: { phone?: string; email?: string; firstname?: string } = {};
        if (!existing.phone && !existing.mobilephone) patch.phone = `+${input.waId}`;
        if (input.verifiedEmail && !existing.email) patch.email = input.verifiedEmail;
        if (input.profileName && !existing.firstname) patch.firstname = input.profileName;
        const changes = Object.keys(patch);
        const contact = changes.length > 0 ? await this.crm.updateContact(existing.id, patch) : existing;
        result = { contact, action: changes.length > 0 ? 'updated' : 'matched', duplicatesFound: Math.max(0, candidates.length - 1), changes };
      }

      await this.store.set(cacheKey, result.contact, this.cacheTtlMs);
      return result;
    });
  }
}
