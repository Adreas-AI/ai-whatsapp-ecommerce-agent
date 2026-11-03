/**
 * Outbound HTTP with timeouts and *bounded* retries.
 *
 * Retry policy:
 *  - 429: retried (the upstream did not process the request), honouring Retry-After up to 5s.
 *  - 5xx / network errors / timeouts: retried only for idempotent requests, because a
 *    non-idempotent POST (create contact, create ticket, send message) may already have
 *    been applied upstream and retrying would duplicate it.
 *  - Everything else fails immediately.
 * maxAttempts is capped at 5 so a misconfiguration can never cause an infinite loop.
 */

export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number | null,
    message: string,
    public readonly retryable: boolean,
    public readonly body?: unknown,
  ) {
    super(`${service}: ${message}`);
    this.name = 'UpstreamError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  idempotent?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Return null instead of throwing on 404. */
  allowNotFound?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_ATTEMPTS_CAP = 5;

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 5000);
  return Math.min(250 * 2 ** (attempt - 1), 4000) + Math.floor(Math.random() * 100);
}

export async function requestJson<T>(service: string, url: string, opts: RequestOptions = {}): Promise<T | null> {
  const method = opts.method ?? 'GET';
  const idempotent = opts.idempotent ?? (method === 'GET' || method === 'PUT' || method === 'DELETE');
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 3, 1), MAX_ATTEMPTS_CAP);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: UpstreamError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'error';
      lastError = new UpstreamError(service, null, `network ${reason}`, idempotent);
      if (idempotent && attempt < maxAttempts) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      if (response.status === 204) return null;
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    }
    if (response.status === 404 && opts.allowNotFound) return null;

    const body = await response.text().catch(() => '');
    let parsed: unknown = body;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      // keep text body
    }
    const retryable = response.status === 429 || (response.status >= 500 && idempotent);
    lastError = new UpstreamError(service, response.status, `HTTP ${response.status}`, retryable, parsed);
    if (retryable && attempt < maxAttempts) {
      await sleep(backoffMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    throw lastError;
  }
  throw lastError ?? new UpstreamError(service, null, 'request failed', false);
}
