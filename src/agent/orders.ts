import { timingSafeEqual } from 'node:crypto';
import type { CommerceClient, Order } from '../integrations/commerce.js';
import type { KeyValueStore } from '../store/kv.js';
import { statusLabel, type CustomerSafeOrder } from './replies.js';

/**
 * Order lookup with ownership verification.
 *
 * Knowing an order number is never enough. Private order details are only
 * returned when one of these holds:
 *   1. the sender's WhatsApp number equals the order's billing phone, or
 *   2. the customer supplies the email address on the order, or
 *   3. the order was already verified earlier in this conversation.
 * "Order not found" and "not your order" produce the same response, so the
 * endpoint cannot be used to discover which order numbers exist. Failed
 * attempts are rate-limited per WhatsApp user and per order number.
 */

export type LookupOutcome = 'verified' | 'need_email' | 'not_verified' | 'locked' | 'invalid_order_number';

export interface LookupResult {
  outcome: LookupOutcome;
  order?: CustomerSafeOrder;
  /** Email that passed verification (used to enrich the CRM contact). */
  verifiedEmail?: string;
}

/** Normalises a stored phone number to international digits for comparison with a WhatsApp wa_id. */
export function normalizePhoneDigits(raw: string | null | undefined, defaultCountryCode?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6) return null;
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  if (!defaultCountryCode) return digits;
  digits = digits.replace(/^0+/, ''); // national trunk prefix, e.g. 0xx in many countries
  // Heuristic: a national number of 10 digits or fewer is missing its country code.
  if (digits.length > 10 && digits.startsWith(defaultCountryCode)) return digits;
  return `${defaultCountryCode}${digits}`;
}

export function phoneMatchesWaId(billingPhone: string | null, waId: string, defaultCountryCode?: string): boolean {
  const normalized = normalizePhoneDigits(billingPhone, defaultCountryCode);
  return normalized !== null && normalized === waId;
}

export function emailMatches(orderEmail: string | null, provided: string): boolean {
  if (!orderEmail) return false;
  const a = Buffer.from(orderEmail.trim().toLowerCase());
  const b = Buffer.from(provided.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function toCustomerSafeOrder(order: Order, verifiedBy: CustomerSafeOrder['verifiedBy']): CustomerSafeOrder {
  // Deliberately excludes addresses, emails, phone numbers, payment and price details.
  return {
    number: order.number,
    status: order.status,
    statusLabel: statusLabel(order.status),
    placedOn: order.createdAt,
    lastUpdate: order.updatedAt,
    items: order.items.slice(0, 10),
    tracking: order.tracking.slice(0, 3),
    estimatedDelivery: order.estimatedDelivery,
    verifiedBy,
  };
}

export class OrderService {
  constructor(
    private readonly commerce: CommerceClient,
    private readonly store: KeyValueStore,
    private readonly opts: { maxFailures: number; windowMs: number; defaultCountryCode?: string; now: () => number },
  ) {}

  private async failures(key: string): Promise<number[]> {
    const now = this.opts.now();
    return ((await this.store.get<number[]>(key)) ?? []).filter((t) => now - t < this.opts.windowMs);
  }

  private async recordFailure(waId: string, orderNumber: string): Promise<void> {
    const now = this.opts.now();
    for (const key of [`verify-fail:wa:${waId}`, `verify-fail:order:${orderNumber}`]) {
      const list = await this.failures(key);
      list.push(now);
      await this.store.set(key, list, this.opts.windowMs);
    }
  }

  async isLocked(waId: string, orderNumber?: string): Promise<boolean> {
    if ((await this.failures(`verify-fail:wa:${waId}`)).length >= this.opts.maxFailures) return true;
    // Many different chats failing on the same order number looks like enumeration/targeting.
    if (orderNumber && (await this.failures(`verify-fail:order:${orderNumber}`)).length >= this.opts.maxFailures * 2) return true;
    return false;
  }

  async lookup(input: { waId: string; orderNumber: string; email?: string; previouslyVerified: boolean }): Promise<LookupResult> {
    if (!/^\d{1,12}$/.test(input.orderNumber)) return { outcome: 'invalid_order_number' };
    if (await this.isLocked(input.waId, input.orderNumber)) return { outcome: 'locked' };

    const order = await this.commerce.getOrder(input.orderNumber);

    if (order && input.previouslyVerified) return { outcome: 'verified', order: toCustomerSafeOrder(order, 'earlier_in_conversation') };
    if (order && phoneMatchesWaId(order.billingPhone, input.waId, this.opts.defaultCountryCode)) {
      return { outcome: 'verified', order: toCustomerSafeOrder(order, 'whatsapp_phone') };
    }
    if (!input.email) {
      // Same answer whether or not the order exists.
      return { outcome: 'need_email' };
    }
    if (order && emailMatches(order.billingEmail, input.email)) {
      return { outcome: 'verified', order: toCustomerSafeOrder(order, 'email'), verifiedEmail: input.email.trim().toLowerCase() };
    }
    await this.recordFailure(input.waId, input.orderNumber);
    if (await this.isLocked(input.waId, input.orderNumber)) return { outcome: 'locked' };
    return { outcome: 'not_verified' };
  }
}
