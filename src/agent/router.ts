import type { TicketPriority } from '../integrations/crm.js';
import { classificationSchema, type Classification, type Intent } from './classifier.js';
import type { ConversationState } from './state.js';

/**
 * Server-side guard. Whatever the model says, this function decides which
 * allowlisted tool runs, with which arguments. The model can at most pick a
 * wrong *intent*; it can never pick a customer, an order it was not given, or
 * a tool outside this list.
 */

export const ROUTES = ['product_search', 'order_lookup', 'escalate', 'reply', 'none'] as const;
export type Route = (typeof ROUTES)[number];

export type EscalationReason = 'customer_request' | 'complaint' | 'verification_locked' | 'low_confidence' | 'tool_error';
export type ReplyKey = 'welcome' | 'clarify' | 'out_of_scope' | 'ask_order_number' | 'ask_email' | 'unsupported_type';

export interface RouteDecision {
  route: Route;
  reason: string;
  intent: Intent;
  confidence: number;
  productQuery?: string;
  orderNumber?: string;
  escalation?: { reason: EscalationReason; priority: TicketPriority };
  replyKey?: ReplyKey;
  guardNotes: string[];
  statePatch: Partial<Pick<ConversationState, 'awaiting' | 'lowConfidenceStreak'>>;
}

export interface GuardInput {
  /** Raw, unvalidated model output (or rule-classifier output). */
  classification: unknown;
  rawText: string | null;
  messageType: string;
  entities: { orderNumber?: string; email?: string };
  state: Pick<ConversationState, 'awaiting' | 'lowConfidenceStreak' | 'handoff'>;
  minConfidence: number;
}

const FALLBACK: Classification = {
  intent: 'other',
  confidence: 0,
  product_query: null,
  order_number: null,
  wants_human: false,
  sentiment: 'neutral',
};

export function decideRoute(input: GuardInput): RouteDecision & { classification: Classification } {
  const notes: string[] = [];
  const parsed = classificationSchema.safeParse(input.classification);
  const c: Classification = parsed.success ? parsed.data : FALLBACK;
  if (!parsed.success) notes.push('classification failed schema validation → treated as "other" with confidence 0');

  const base = { intent: c.intent, confidence: c.confidence, guardNotes: notes, classification: c };

  if (input.state.handoff?.active) {
    return { ...base, route: 'none', reason: 'human handoff active: bot stays silent', statePatch: {} };
  }
  if (input.rawText === null) {
    return { ...base, route: 'reply', replyKey: 'unsupported_type', reason: `unsupported message type "${input.messageType}"`, statePatch: {} };
  }

  // The model may only *echo* an order number that literally appears in the message.
  let modelOrderNumber: string | undefined;
  if (c.order_number) {
    const digits = c.order_number.replace(/\D/g, '');
    if (digits && /^\d{1,12}$/.test(digits) && new RegExp(`(^|\\D)${digits}(\\D|$)`).test(input.rawText)) modelOrderNumber = digits;
    else notes.push(`discarded model order_number "${c.order_number.slice(0, 20)}": not present in the customer message`);
  }
  const orderNumber = input.entities.orderNumber ?? modelOrderNumber;

  // Continue a pending verification first: the customer is answering our question.
  const awaiting = input.state.awaiting;
  if (awaiting?.kind === 'email' && input.entities.email) {
    return { ...base, route: 'order_lookup', orderNumber: awaiting.orderNumber, reason: 'customer supplied the email we asked for', statePatch: { awaiting: undefined, lowConfidenceStreak: 0 } };
  }

  if (c.intent === 'human_handoff' || c.wants_human) {
    const complaint = c.sentiment === 'negative' && !c.wants_human;
    return {
      ...base,
      route: 'escalate',
      escalation: { reason: complaint ? 'complaint' : 'customer_request', priority: c.sentiment === 'negative' ? 'HIGH' : 'MEDIUM' },
      reason: c.wants_human ? 'customer asked for a human' : 'issue needs a human (complaint/refund/damage)',
      statePatch: { awaiting: undefined, lowConfidenceStreak: 0 },
    };
  }

  if (awaiting?.kind === 'order_number' && orderNumber) {
    return { ...base, route: 'order_lookup', orderNumber, reason: 'customer supplied the order number we asked for', statePatch: { awaiting: undefined, lowConfidenceStreak: 0 } };
  }

  if (c.confidence < input.minConfidence) {
    const streak = input.state.lowConfidenceStreak + 1;
    if (streak >= 2) {
      return {
        ...base,
        route: 'escalate',
        escalation: { reason: 'low_confidence', priority: 'MEDIUM' },
        reason: `confidence ${c.confidence.toFixed(2)} below ${input.minConfidence} twice in a row`,
        statePatch: { lowConfidenceStreak: 0, awaiting: undefined },
      };
    }
    return { ...base, route: 'reply', replyKey: 'clarify', reason: `confidence ${c.confidence.toFixed(2)} below ${input.minConfidence}`, statePatch: { lowConfidenceStreak: streak } };
  }

  switch (c.intent) {
    case 'order_status':
      if (orderNumber) return { ...base, route: 'order_lookup', orderNumber, reason: 'order status with order number', statePatch: { awaiting: undefined, lowConfidenceStreak: 0 } };
      return { ...base, route: 'reply', replyKey: 'ask_order_number', reason: 'order status without order number', statePatch: { awaiting: { kind: 'order_number' }, lowConfidenceStreak: 0 } };
    case 'product_question': {
      const query = (c.product_query ?? '').replace(/[^\p{L}\p{N}\s'&.-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!query) return { ...base, route: 'reply', replyKey: 'clarify', reason: 'product question without searchable keywords', statePatch: { lowConfidenceStreak: 0 } };
      return { ...base, route: 'product_search', productQuery: query, reason: 'product question', statePatch: { awaiting: undefined, lowConfidenceStreak: 0 } };
    }
    case 'greeting':
      return { ...base, route: 'reply', replyKey: 'welcome', reason: 'greeting', statePatch: { lowConfidenceStreak: 0 } };
    default:
      return { ...base, route: 'reply', replyKey: 'out_of_scope', reason: 'outside supported intents', statePatch: { lowConfidenceStreak: 0 } };
  }
}
