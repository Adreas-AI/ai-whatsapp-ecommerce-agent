import type { Product } from '../integrations/commerce.js';
import type { ReplyKey } from './router.js';

/**
 * Every customer-facing sentence is produced here from tool results.
 * The LLM never writes replies, so it cannot invent stock levels, order
 * statuses or delivery dates. If a fact is missing, the reply says so.
 */

export interface CustomerSafeOrder {
  number: string;
  status: string;
  statusLabel: string;
  placedOn: string | null;
  lastUpdate: string | null;
  items: { name: string; quantity: number }[];
  tracking: { provider: string; number: string; url: string | null; shippedAt: string | null }[];
  estimatedDelivery: string | null;
  verifiedBy: 'whatsapp_phone' | 'email' | 'earlier_in_conversation';
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending payment',
  processing: 'Processing: being prepared for shipment',
  'on-hold': 'On hold: our team needs to review it',
  completed: 'Completed (fulfilled by the store)',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  failed: 'Payment failed',
  'checkout-draft': 'Not yet placed (draft)',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? `Status "${status.replace(/[^\w -]/g, '').slice(0, 30)}"`;
}

const date = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

function stockLabel(p: Product): string {
  switch (p.stockStatus) {
    case 'instock':
      return p.stockQuantity !== null && p.stockQuantity <= 5 ? `In stock (only ${p.stockQuantity} left)` : 'In stock';
    case 'outofstock':
      return 'Out of stock';
    case 'onbackorder':
      return 'Available on backorder (no ship date confirmed)';
    default:
      return 'Availability not confirmed: please ask our team';
  }
}

export interface ReplyContext {
  storeName: string;
  supportEmail: string;
}

export function staticReply(key: ReplyKey, ctx: ReplyContext, orderNumber?: string): string {
  switch (key) {
    case 'welcome':
      return `Hi! 👋 I'm the ${ctx.storeName} assistant. I can check product availability and prices, look up the status of your order, or connect you with our team. How can I help?`;
    case 'clarify':
      return "Sorry, I didn't quite catch that. I can help with:\n• product availability and prices\n• the status of an order\n• connecting you with a team member\nWhat would you like to do?";
    case 'out_of_scope':
      return 'I can only help with product questions, order status, or connecting you with our team. Type "agent" any time to reach a person.';
    case 'ask_order_number':
      return "Sure, what's your order number? You'll find it in your order confirmation email (for example #1234).";
    case 'ask_email':
      return `To protect your privacy I need to confirm this is your order. Please reply with the email address used for order #${orderNumber ?? ''}.`;
    case 'unsupported_type':
      return 'Thanks! I can only read text messages at the moment. Could you type your question?';
  }
}

export const replies = {
  askEmail: (orderNumber: string) => staticReply('ask_email', { storeName: '', supportEmail: '' }, orderNumber),
  notVerified: () =>
    "I couldn't verify an order with those details, so I can't share anything about it. Please double-check the order number and the email used at checkout, or type \"agent\" to reach our team.",
  invalidOrderNumber: () => 'That doesn\'t look like a valid order number. It should be the digits from your confirmation email, for example #1234.',
  products(products: Product[], query: string): string {
    if (products.length === 0) {
      return `I couldn't find a product matching "${query.slice(0, 60)}" in our catalogue, and I don't want to guess. Could you describe it differently, or type "agent" to ask our team?`;
    }
    const lines = products.map((p) => `• ${p.name}: ${p.price ? `${p.price} ${p.currency}` : 'price on request'}, ${stockLabel(p)}`);
    return `Here's what I found in our catalogue:\n${lines.join('\n')}\nStock changes quickly and is confirmed at checkout.`;
  },
  orderStatus(o: CustomerSafeOrder): string {
    const lines = [`Order #${o.number} (verified ✅)`, `Status: ${o.statusLabel}`];
    const placed = date(o.placedOn);
    const updated = date(o.lastUpdate);
    if (placed) lines.push(`Placed: ${placed}${updated && updated !== placed ? ` · Last update: ${updated}` : ''}`);
    if (o.items.length) lines.push(`Items: ${o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}`);
    for (const t of o.tracking) lines.push(`Tracking: ${t.provider} ${t.number}${t.shippedAt ? ` (shipped ${t.shippedAt})` : ''}${t.url ? `\n${t.url}` : ''}`);
    lines.push(
      o.estimatedDelivery
        ? `Estimated delivery: ${o.estimatedDelivery} (as provided by the store)`
        : "Estimated delivery: not available yet. I won't guess a date; type \"agent\" if you need one.",
    );
    return lines.join('\n');
  },
  escalated: (ticketId: string) =>
    `I've passed your conversation to our support team (ticket ${ticketId}). A team member will reply here as soon as possible. The automated assistant will stay quiet until then.`,
  escalatedNoTicket: (supportEmail: string) =>
    `I'm connecting you with our team, but I couldn't open a support ticket automatically. If you don't hear from us soon, please email ${supportEmail}.`,
  verificationLocked: (ticketId: string | null, supportEmail: string) =>
    `For your security I've paused order lookups in this chat after several unsuccessful verification attempts. ${
      ticketId ? `A team member will follow up (ticket ${ticketId}).` : `Please contact ${supportEmail}.`
    }`,
  technicalIssue: (supportEmail: string) =>
    `Sorry, I'm having a technical problem right now and couldn't complete that. I've flagged it for our team. You can also email ${supportEmail}.`,
};
