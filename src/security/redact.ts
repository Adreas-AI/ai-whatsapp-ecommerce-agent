import { createHash } from 'node:crypto';

/**
 * PII handling helpers. Used before text reaches the LLM, logs, traces and
 * HubSpot ticket bodies. Redaction is best-effort pattern matching, not a
 * guarantee; keep LOG_MESSAGE_TEXT=false in production.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Digit runs (with common separators) long enough to be phone or card numbers.
const LONG_NUMBER = /(?<![\w@])\+?\d[\d\s().-]{5,}\d(?![\w@])/g;

export function redactText(text: string): string {
  return text.replace(EMAIL, '[EMAIL]').replace(LONG_NUMBER, (match) => {
    const digits = match.replace(/\D/g, '').length;
    if (digits >= 13) return '[CARD_OR_ID]';
    if (digits >= 8) return '[PHONE]';
    return match;
  });
}

export function extractEmail(text: string): string | undefined {
  const match = text.match(EMAIL);
  return match?.[0]?.toLowerCase();
}

const ORDER_WITH_KEYWORD =
  /(?:order|ord\.?|#|no\.?|number|nr\.?|παραγγελ\w*|pedido|commande|bestellung)\s*(?:number|no\.?|nr\.?|#|id)?\s*[:#]?\s*#?(\d{3,12})\b/i;
const HASH_NUMBER = /#\s?(\d{3,12})\b/;
const DIGITS_ONLY = /^\s*#?\s*(\d{3,12})\s*[.!?]?\s*$/;

/**
 * Pulls an order number out of free text. `expectingOrderNumber` lets a reply
 * that is only digits ("1002") count after the bot asked for an order number.
 */
export function extractOrderNumber(text: string, expectingOrderNumber = false): string | undefined {
  const keyword = text.match(ORDER_WITH_KEYWORD) ?? text.match(HASH_NUMBER);
  if (keyword?.[1]) return keyword[1];
  if (expectingOrderNumber) return text.match(DIGITS_ONLY)?.[1];
  return undefined;
}

/** "15550100001" -> "1555*****01". Keeps logs useful without storing full numbers. */
export function maskPhone(value: string | undefined | null): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`;
}

export function maskEmail(value: string | undefined | null): string {
  if (!value) return '';
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Stable pseudonymous id for correlating log lines without the raw identifier. */
export function pseudonymize(value: string, salt = ''): string {
  return createHash('sha256').update(`${salt}:${value}`).digest('hex').slice(0, 12);
}

/** Strip HTML and control characters from untrusted upstream strings (e.g. WooCommerce descriptions). */
export function sanitizeUpstreamText(value: unknown, maxLength = 200): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    // eslint-disable-next-line no-control-regex -- intentionally strips control characters from upstream text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
