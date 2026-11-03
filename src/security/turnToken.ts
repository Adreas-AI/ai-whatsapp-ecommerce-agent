import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A turn token is a short-lived capability the gateway issues for one inbound
 * WhatsApp message. Tool endpoints derive the customer's identity (wa_id) from
 * this token, never from the request body, so neither n8n nor the LLM can make
 * a tool act on behalf of a different customer.
 */
export interface TurnClaims {
  messageId: string;
  waId: string;
  exp: number;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createTurnToken(claims: Omit<TurnClaims, 'exp'>, secret: string, ttlMs: number, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ mid: claims.messageId, wa: claims.waId, exp: now + ttlMs }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyTurnToken(token: string | undefined, secret: string, now = Date.now()): TurnClaims | null {
  if (!token || token.length > 1024) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { mid?: unknown; wa?: unknown; exp?: unknown };
    if (typeof data.mid !== 'string' || typeof data.wa !== 'string' || typeof data.exp !== 'number') return null;
    if (data.exp < now) return null;
    return { messageId: data.mid, waId: data.wa, exp: data.exp };
  } catch {
    return null;
  }
}
