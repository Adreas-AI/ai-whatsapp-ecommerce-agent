import { maskEmail, maskPhone, redactText } from '../security/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SECRET_KEYS = /(token|secret|authorization|password|api[_-]?key|consumer[_-]?(key|secret)|signature|cookie)/i;
const PHONE_KEYS = /^(waId|wa_id|from|to|phone|mobilephone|billingPhone)$/i;
const EMAIL_KEYS = /^(email|billingEmail)$/i;
const TEXT_KEYS = /^(text|body|message|content|rawText)$/i;

/** Redacts secrets and PII from structured log fields. Exported for tests. */
export function sanitizeFields(value: unknown, logMessageText: boolean, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => sanitizeFields(v, logMessageText, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) out[key] = '[REDACTED]';
      else if (PHONE_KEYS.test(key) && typeof v === 'string') out[key] = maskPhone(v);
      else if (EMAIL_KEYS.test(key) && typeof v === 'string') out[key] = maskEmail(v);
      else if (TEXT_KEYS.test(key) && typeof v === 'string') out[key] = logMessageText ? redactText(v) : `[${v.length} chars]`;
      else out[key] = sanitizeFields(v, logMessageText, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(level: LogLevel = 'info', opts: { logMessageText?: boolean; write?: (line: string) => void } = {}): Logger {
  const min = ORDER[level];
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < min) return;
    const record = { ts: new Date().toISOString(), level: lvl, msg, ...(sanitizeFields(fields ?? {}, opts.logMessageText ?? false) as object) };
    write(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('silent');
