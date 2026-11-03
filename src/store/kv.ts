/**
 * Minimal async key-value store with TTLs.
 *
 * The interface is async so a Redis (or Postgres) implementation can replace
 * MemoryStore without touching callers. MemoryStore is fine for a single
 * gateway instance; run more than one replica only with a shared store.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  /** Atomically stores the value only if the key is absent. Returns true if it was stored. */
  setIfAbsent<T>(key: string, value: T, ttlMs: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): Entry | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | undefined> {
    // structuredClone keeps callers from mutating stored state by reference, like a real store would.
    const entry = this.live(key);
    return entry ? (structuredClone(entry.value) as T) : undefined;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.data.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlMs });
  }

  async setIfAbsent<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.data.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlMs });
    return true;
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix) && this.live(k));
  }

  /** Drops expired entries. Called on an interval by the server. */
  sweep(): number {
    let removed = 0;
    for (const key of [...this.data.keys()]) {
      if (!this.live(key)) removed++;
    }
    return removed;
  }

  clear(): void {
    this.data.clear();
  }
}

/** Serialises async work per key, e.g. "one CRM upsert per WhatsApp user at a time". */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
