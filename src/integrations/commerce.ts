import { z } from 'zod';
import { DEMO_ORDERS, DEMO_PRODUCTS } from '../demo/fixtures.js';
import { sanitizeUpstreamText } from '../security/redact.js';
import { requestJson, type RequestOptions } from './http.js';

export type StockStatus = 'instock' | 'outofstock' | 'onbackorder' | 'unknown';

export interface Product {
  id: string;
  name: string;
  price: string | null;
  currency: string;
  stockStatus: StockStatus;
  stockQuantity: number | null;
  url: string | null;
  shortDescription: string;
}

export interface Order {
  id: string;
  number: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  items: { name: string; quantity: number }[];
  tracking: { provider: string; number: string; url: string | null; shippedAt: string | null }[];
  /** Only set when the store itself provides a date. Never computed or guessed. */
  estimatedDelivery: string | null;
}

export interface CommerceClient {
  readonly mock: boolean;
  searchProducts(query: string, limit: number): Promise<Product[]>;
  /** Returns null when the order does not exist. */
  getOrder(orderNumber: string): Promise<Order | null>;
}

// ---------------------------------------------------------------------------
// WooCommerce REST API v3 (wp-json/wc/v3). Auth: consumer key/secret over HTTPS.
// ---------------------------------------------------------------------------

const wooProduct = z.object({
  id: z.number(),
  name: z.string(),
  price: z.union([z.string(), z.number()]).nullable().optional(),
  stock_status: z.string().optional(),
  stock_quantity: z.number().nullable().optional(),
  manage_stock: z.boolean().optional(),
  permalink: z.string().optional(),
  short_description: z.string().optional(),
});

const wooMeta = z.object({ key: z.string(), value: z.unknown() });

const wooOrder = z.object({
  id: z.number(),
  number: z.union([z.string(), z.number()]).optional(),
  status: z.string(),
  date_created_gmt: z.string().nullable().optional(),
  date_modified_gmt: z.string().nullable().optional(),
  billing: z.object({ email: z.string().nullable().optional(), phone: z.string().nullable().optional() }).partial().optional(),
  line_items: z.array(z.object({ name: z.string(), quantity: z.number() })).optional(),
  meta_data: z.array(wooMeta).optional(),
});

const trackingItem = z.object({
  tracking_provider: z.string().optional(),
  custom_tracking_provider: z.string().optional(),
  tracking_number: z.string().optional(),
  custom_tracking_link: z.string().optional(),
  date_shipped: z.union([z.string(), z.number()]).optional(),
});

const STOCK: Record<string, StockStatus> = { instock: 'instock', outofstock: 'outofstock', onbackorder: 'onbackorder' };

export class WooCommerceClient implements CommerceClient {
  readonly mock = false;

  constructor(
    private readonly opts: {
      baseUrl: string;
      consumerKey: string;
      consumerSecret: string;
      currency: string;
      etaMetaKey?: string;
      http?: Pick<RequestOptions, 'fetchImpl' | 'sleep'>;
    },
  ) {}

  private get auth(): string {
    return `Basic ${Buffer.from(`${this.opts.consumerKey}:${this.opts.consumerSecret}`).toString('base64')}`;
  }

  async searchProducts(query: string, limit: number): Promise<Product[]> {
    const url = new URL(`${this.opts.baseUrl}/wp-json/wc/v3/products`);
    url.searchParams.set('search', query.slice(0, 80));
    url.searchParams.set('status', 'publish');
    url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 10)));
    const data = await requestJson<unknown[]>('woocommerce', url.toString(), {
      headers: { authorization: this.auth },
      ...this.opts.http,
    });
    const items = z.array(wooProduct).catch([]).parse(data ?? []);
    return items.map((p) => ({
      id: String(p.id),
      name: sanitizeUpstreamText(p.name, 120),
      price: p.price === undefined || p.price === null || p.price === '' ? null : String(p.price),
      currency: this.opts.currency,
      stockStatus: STOCK[p.stock_status ?? ''] ?? 'unknown',
      stockQuantity: p.manage_stock ? (p.stock_quantity ?? null) : null,
      url: p.permalink && p.permalink.startsWith(this.opts.baseUrl) ? p.permalink : null,
      shortDescription: sanitizeUpstreamText(p.short_description, 160),
    }));
  }

  async getOrder(orderNumber: string): Promise<Order | null> {
    if (!/^\d{1,12}$/.test(orderNumber)) return null;
    // Assumes the customer-facing order number equals the order ID (WooCommerce default).
    // Stores using a sequential-order-number plugin need a lookup by that plugin's meta key.
    const data = await requestJson<unknown>('woocommerce', `${this.opts.baseUrl}/wp-json/wc/v3/orders/${orderNumber}`, {
      headers: { authorization: this.auth },
      allowNotFound: true,
      ...this.opts.http,
    });
    if (!data) return null;
    const parsed = wooOrder.safeParse(data);
    if (!parsed.success) return null;
    const o = parsed.data;
    const number = String(o.number ?? o.id);
    if (number !== orderNumber && String(o.id) !== orderNumber) return null;

    const meta = new Map((o.meta_data ?? []).map((m) => [m.key, m.value]));
    const trackingRaw = z.array(trackingItem).safeParse(meta.get('_wc_shipment_tracking_items'));
    const etaRaw = this.opts.etaMetaKey ? meta.get(this.opts.etaMetaKey) : undefined;

    return {
      id: String(o.id),
      number,
      status: o.status,
      createdAt: o.date_created_gmt ?? null,
      updatedAt: o.date_modified_gmt ?? null,
      billingEmail: o.billing?.email ?? null,
      billingPhone: o.billing?.phone ?? null,
      items: (o.line_items ?? []).map((li) => ({ name: sanitizeUpstreamText(li.name, 120), quantity: li.quantity })),
      tracking: trackingRaw.success
        ? trackingRaw.data
            .filter((t) => t.tracking_number)
            .map((t) => ({
              provider: sanitizeUpstreamText(t.custom_tracking_provider || t.tracking_provider || 'carrier', 60),
              number: sanitizeUpstreamText(t.tracking_number, 60),
              url: t.custom_tracking_link?.startsWith('https://') ? t.custom_tracking_link : null,
              shippedAt:
                typeof t.date_shipped === 'number' || /^\d+$/.test(String(t.date_shipped ?? ''))
                  ? new Date(Number(t.date_shipped) * 1000).toISOString().slice(0, 10)
                  : null,
            }))
        : [],
      estimatedDelivery: typeof etaRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(etaRaw) ? etaRaw.slice(0, 10) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock (DEMO_MODE): fictional catalogue and orders from demo/fixtures.ts.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a an the do does you your have has is are in of for any some me my i it this that what which how much stock available availability price cost sell buy want looking please can could there still left'.split(
    ' ',
  ),
);

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map((t) => t.replace(/s$/, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class MockCommerceClient implements CommerceClient {
  readonly mock = true;
  public failNext: Error | null = null;

  async searchProducts(query: string, limit: number): Promise<Product[]> {
    this.maybeFail();
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    const scored = DEMO_PRODUCTS.map((p) => {
      const haystack = [...p.tags, ...queryTokens(p.name)];
      const score = tokens.filter((t) => haystack.some((h) => h.startsWith(t) || t.startsWith(h))).length;
      return { p, score };
    })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ p }) => {
      const { tags: _tags, ...product } = p;
      return product;
    });
  }

  async getOrder(orderNumber: string): Promise<Order | null> {
    this.maybeFail();
    const order = DEMO_ORDERS.find((o) => o.number === orderNumber);
    return order ? structuredClone(order) : null;
  }

  private maybeFail() {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }
}
