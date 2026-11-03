import type { Classification } from '../agent/classifier.js';
import type { CustomerSafeOrder } from '../agent/replies.js';

/**
 * In-memory ring buffer of recent turns for the dashboard. In live mode the
 * stored text is redacted and phone numbers are masked before they get here.
 */

export interface ToolCallTrace {
  name: string;
  mock: boolean;
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  durationMs: number;
  summary: string;
  detail?: unknown;
}

export interface TurnTrace {
  turnId: string;
  waIdDisplay: string;
  profileName: string | null;
  receivedAt: string;
  orchestrator: 'local' | 'n8n';
  demo: boolean;
  messageType: string;
  inboundText: string | null;
  status: 'processing' | 'done' | 'duplicate' | 'error';
  classification?: Classification & { source: string; mock: boolean };
  route?: { route: string; reason: string; guardNotes: string[] };
  toolCalls: ToolCallTrace[];
  orderLookup?: { outcome: string; order?: CustomerSafeOrder };
  crmUpdates: string[];
  reply?: { text: string; delivery: string; mock: boolean };
}

export class TraceStore {
  private readonly turns = new Map<string, TurnTrace>();

  constructor(private readonly capacity = 100) {}

  start(trace: Omit<TurnTrace, 'toolCalls' | 'crmUpdates' | 'status'> & Partial<Pick<TurnTrace, 'status'>>): TurnTrace {
    const full: TurnTrace = { status: 'processing', toolCalls: [], crmUpdates: [], ...trace };
    this.turns.set(full.turnId, full);
    while (this.turns.size > this.capacity) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
    return full;
  }

  update(turnId: string, fn: (t: TurnTrace) => void): void {
    const t = this.turns.get(turnId);
    if (t) fn(t);
  }

  addToolCall(turnId: string, call: ToolCallTrace): void {
    this.update(turnId, (t) => {
      t.toolCalls.push(call);
      if (t.toolCalls.length > 30) t.toolCalls.shift();
    });
  }

  get(turnId: string): TurnTrace | undefined {
    return this.turns.get(turnId);
  }

  list(limit = 50): TurnTrace[] {
    return [...this.turns.values()].slice(-limit).reverse();
  }

  clear(): void {
    this.turns.clear();
  }
}
