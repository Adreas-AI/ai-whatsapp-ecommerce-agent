import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta webhook verification.
 *
 * 1. Subscription challenge (GET): Meta calls the callback URL with
 *    hub.mode=subscribe, hub.verify_token=<your token>, hub.challenge=<random>.
 *    Respond 200 with the challenge as plain text only if the token matches.
 * 2. Event delivery (POST): every payload is signed with the app secret.
 *    Header: X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body)>.
 *    Verify against the *raw* bytes, before JSON parsing.
 */

export interface VerificationResult {
  status: 200 | 400 | 403;
  body: string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function handleVerificationChallenge(params: URLSearchParams, expectedToken: string): VerificationResult {
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');
  if (mode !== 'subscribe' || token === null || !safeEqual(token, expectedToken)) {
    return { status: 403, body: 'Forbidden' };
  }
  // Meta sends a numeric-looking string. Refuse anything else rather than reflect it.
  if (!challenge || !/^[A-Za-z0-9._-]{1,256}$/.test(challenge)) {
    return { status: 400, body: 'Bad Request' };
  }
  return { status: 200, body: challenge };
}

export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function verifyMetaSignature(rawBody: Buffer, header: string | string[] | undefined, appSecret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(provided, 'hex'));
}
