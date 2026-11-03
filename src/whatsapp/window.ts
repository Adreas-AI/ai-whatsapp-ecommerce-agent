/**
 * WhatsApp customer service window.
 *
 * Free-form messages may only be sent within 24 hours of the customer's last
 * inbound message. Outside the window, only a pre-approved template may be
 * sent, and this project only does so as a follow-up on a conversation the
 * customer started (e.g. a human agent answering an open ticket). It never
 * messages numbers that have not contacted the business first.
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type OutboundPurpose = 'bot_reply' | 'agent_followup';

export type OutboundDecision =
  | { kind: 'text' }
  | { kind: 'template'; name: string; language: string }
  | { kind: 'blocked'; reason: 'no_prior_customer_message' | 'window_closed' | 'window_closed_no_template' };

export function isWindowOpen(lastInboundAt: number | undefined, now: number): boolean {
  return lastInboundAt !== undefined && now - lastInboundAt < SERVICE_WINDOW_MS && now >= lastInboundAt - 60_000;
}

export function decideOutbound(input: {
  lastInboundAt: number | undefined;
  now: number;
  purpose: OutboundPurpose;
  templateName?: string;
  templateLanguage: string;
}): OutboundDecision {
  if (input.lastInboundAt === undefined) return { kind: 'blocked', reason: 'no_prior_customer_message' };
  if (isWindowOpen(input.lastInboundAt, input.now)) return { kind: 'text' };
  // The bot never re-engages on its own outside the window.
  if (input.purpose === 'bot_reply') return { kind: 'blocked', reason: 'window_closed' };
  if (!input.templateName) return { kind: 'blocked', reason: 'window_closed_no_template' };
  return { kind: 'template', name: input.templateName, language: input.templateLanguage };
}
