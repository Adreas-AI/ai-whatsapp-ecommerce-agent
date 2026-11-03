import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_SECRETS } from '../src/config.js';
import { signPayload, verifyMetaSignature } from '../src/whatsapp/verify.js';
import { fixture, makeHarness, startServer, waitFor } from './helpers.js';

const SECRET = 'test-app-secret-0123456789abcdef';
const body = Buffer.from(fixture('meta/text-message.json'));

describe('X-Hub-Signature-256 verification', () => {
  it('accepts a correct HMAC-SHA256 of the raw body', () => {
    const header = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, header, SECRET)).toBe(true);
  });

  it('accepts upper-case hex digests', () => {
    expect(verifyMetaSignature(body, signPayload(body, SECRET).toUpperCase().replace('SHA256=', 'sha256='), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = signPayload(body, SECRET);
    const tampered = Buffer.from(body.toString().replace('#1002', '#1003'));
    expect(verifyMetaSignature(tampered, header, SECRET)).toBe(false);
  });

  it('is computed over raw bytes: re-serialised JSON with the same content fails', () => {
    const header = signPayload(body, SECRET);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
    expect(reserialised.equals(body)).toBe(false);
    expect(verifyMetaSignature(reserialised, header, SECRET)).toBe(false);
  });

  it('rejects the wrong secret, missing, malformed, sha1 and array headers', () => {
    expect(verifyMetaSignature(body, signPayload(body, 'other-secret'), SECRET)).toBe(false);
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=nothex', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}`, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, [signPayload(body, SECRET)], SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=' + 'a'.repeat(63), SECRET)).toBe(false);
  });
});

describe('POST /webhook enforces signatures on real HTTP traffic', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('returns 401 and processes nothing when the signature is missing', async () => {
    const h = makeHarness();
    const srv = await startServer(h);
    close = srv.close;
    const res = await fetch(`${srv.url}/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
    expect(h.traces.list()).toHaveLength(0);
    expect(h.waMock.outbox).toHaveLength(0);
  });

  it('returns 401 for a signature made with a different secret', async () => {
    const h = makeHarness();
    const srv = await startServer(h);
    close = srv.close;
    const res = await fetch(`${srv.url}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': signPayload(body, 'attacker') } });
    expect(res.status).toBe(401);
    expect(h.traces.list()).toHaveLength(0);
  });

  it('returns 200 quickly and processes a correctly signed delivery', async () => {
    const h = makeHarness();
    const srv = await startServer(h);
    close = srv.close;
    const res = await fetch(`${srv.url}/webhook`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signPayload(body, DEMO_SECRETS.appSecret) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1 });
    await waitFor(() => h.waMock.outbox.length === 1);
    expect(h.lastReply()).toContain('Order #1002');
  });

  it('ignores status-only deliveries without replying', async () => {
    const h = makeHarness();
    const raw = Buffer.from(fixture('meta/status-update.json'));
    const r = await h.gateway.receive(raw, signPayload(raw, DEMO_SECRETS.appSecret));
    await r.processing;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ received: 0 });
    expect(h.waMock.outbox).toHaveLength(0);
  });

  it('rejects oversized bodies with 413', async () => {
    const h = makeHarness();
    const srv = await startServer(h);
    close = srv.close;
    const big = Buffer.alloc(1_100_000, 'a');
    const res = await fetch(`${srv.url}/webhook`, { method: 'POST', body: big, headers: { 'x-hub-signature-256': signPayload(big, DEMO_SECRETS.appSecret) } });
    expect(res.status).toBe(413);
  });
});
