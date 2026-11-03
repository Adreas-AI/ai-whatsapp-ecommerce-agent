import { KeyedMutex, type KeyValueStore } from '../store/kv.js';

export interface ConversationState {
  waId: string;
  firstSeenAt: number;
  lastInboundAt?: number;
  profileName: string | null;
  crmContactId?: string;
  /** What the bot asked for last, so a bare "1002" or an email is understood. */
  awaiting?: { kind: 'order_number' } | { kind: 'email'; orderNumber: string };
  /** Orders whose ownership was verified in this conversation. */
  verifiedOrders: string[];
  lowConfidenceStreak: number;
  handoff?: { active: boolean; ticketId: string | null; reason: string; since: number };
}

/** Per-customer conversation state with a retention TTL (GDPR storage limitation). */
export class ConversationRepo {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly store: KeyValueStore,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  private key(waId: string) {
    return `conv:${waId}`;
  }

  async get(waId: string): Promise<ConversationState> {
    return (
      (await this.store.get<ConversationState>(this.key(waId))) ?? {
        waId,
        firstSeenAt: this.now(),
        profileName: null,
        verifiedOrders: [],
        lowConfidenceStreak: 0,
      }
    );
  }

  /** Read-modify-write under a per-customer lock. */
  async update(waId: string, fn: (state: ConversationState) => void | Promise<void>): Promise<ConversationState> {
    return this.mutex.run(waId, async () => {
      const state = await this.get(waId);
      await fn(state);
      await this.store.set(this.key(waId), state, this.ttlMs);
      return state;
    });
  }

  async delete(waId: string): Promise<void> {
    await this.store.delete(this.key(waId));
  }
}
