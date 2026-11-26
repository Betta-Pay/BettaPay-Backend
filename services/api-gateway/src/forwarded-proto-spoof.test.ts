import test from 'tape';
import {
  buildCsrfCookieHeader,
  getAuthCookieOptions,
  isRequestHttps,
} from './auth-hardening.js';

// Follow-up coverage for #985: only `request.protocol` decides whether a request counts as HTTPS.

test('a spoofed x-forwarded-proto header is ignored when the protocol is http (#985)', (t) => {
  for (const header of ['https', 'HTTPS', ['https'], 'https, https']) {
    const request = { protocol: 'http', headers: { 'x-forwarded-proto': header } };
    t.equal(isRequestHttps(request), false, `ignored: ${JSON.stringify(header)}`);
  }
  t.end();
});

test('a missing protocol is treated as http even with an https header (#985)', (t) => {
  t.equal(isRequestHttps({ headers: { 'x-forwarded-proto': 'https' } }), false);
  t.equal(isRequestHttps({}), false);
  t.end();
});

test('the protocol from the trusted proxy setup is honoured in any case (#985)', (t) => {
  t.equal(isRequestHttps({ protocol: 'https' }), true);
  t.equal(isRequestHttps({ protocol: 'HTTPS' }), true);
  t.equal(isRequestHttps({ protocol: 'https', headers: { 'x-forwarded-proto': 'http' } }), true, 'the header cannot downgrade it either');
  t.end();
});

test('cookie flags follow the protocol, not the header (#985)', (t) => {
  const spoofed = { protocol: 'http', headers: { 'x-forwarded-proto': 'https' } };
  const real = { protocol: 'https', headers: {} };

  t.equal(getAuthCookieOptions(spoofed).secure, false, 'no Secure on a spoofed request');
  t.equal(getAuthCookieOptions(real).secure, true, 'Secure on a real HTTPS request');
  t.notOk(buildCsrfCookieHeader('csrf', 'token', spoofed).includes('Secure'), 'the CSRF cookie has no Secure flag');
  t.ok(buildCsrfCookieHeader('csrf', 'token', real).split('; ').includes('Secure'), 'the CSRF cookie is Secure');
  t.end();
});
