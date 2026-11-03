import { afterEach, describe, expect, it } from 'vitest';
import { handleVerificationChallenge } from '../src/whatsapp/verify.js';
import { fixture, makeHarness, startServer } from './helpers.js';

const cases = JSON.parse(fixture('meta/verification-challenge.json')) as Record<string, Record<string, string>>;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe('Meta webhook verification challenge (GET /webhook)', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('echoes hub.challenge as plain text when mode and token match', async () => {
    const srv = await startServer(makeHarness());
    close = srv.close;
    const res = await fetch(`${srv.url}/webhook?${qs(cases.valid!)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('1158201444');
  });

  it('rejects a wrong verify token with 403 and does not echo the challenge', async () => {
    const srv = await startServer(makeHarness());
    close = srv.close;
    const res = await fetch(`${srv.url}/webhook?${qs(cases.wrong_token!)}`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('1158201444');
  });

  it('rejects a mode other than "subscribe"', () => {
    expect(handleVerificationChallenge(new URLSearchParams(cases.wrong_mode), 'demo-verify-token').status).toBe(403);
  });

  it('rejects requests with no parameters', () => {
    expect(handleVerificationChallenge(new URLSearchParams(), 'demo-verify-token').status).toBe(403);
  });

  it('refuses to reflect a challenge containing markup', () => {
    const r = handleVerificationChallenge(
      new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'demo-verify-token', 'hub.challenge': '<script>alert(1)</script>' }),
      'demo-verify-token',
    );
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('script');
  });

  it('uses the configured token, not the demo default, in live configuration', () => {
    const r = handleVerificationChallenge(new URLSearchParams(cases.valid), 'a-long-production-verify-token');
    expect(r.status).toBe(403);
  });
});
