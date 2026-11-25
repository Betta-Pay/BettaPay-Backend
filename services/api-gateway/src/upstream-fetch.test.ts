import test from 'tape';
import Fastify from 'fastify';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS,
  DOWNSTREAM_DEADLINE_RATIO,
  UpstreamTimeoutError,
  SsrfRejectedError,
  createDownstreamAbortSignal,
  fetchUpstream,
  getDownstreamDeadlineMs,
  getRequestTimeoutMs,
  validateUpstreamUrl,
  isPrivateOrReservedHost,
} from './upstream-fetch.js';

function buildRequest(headers: Record<string, string> = {}, startTime = Date.now()) {
  return {
    headers,
    __startTime: startTime,
  } as any;
}

test('getRequestTimeoutMs reads Request-Timeout header and enforces limits (#980)', (t) => {
  // Defaults when omitted or empty
  t.equal(getRequestTimeoutMs(buildRequest()), DEFAULT_REQUEST_TIMEOUT_MS, 'returns default timeout when header omitted');

  // Valid values within bounds
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '5000' })), 5000, 'returns parsed timeout when within bounds');
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '1' })), 1, 'accepts minimum positive timeout of 1ms');

  // Invalid or non-positive values fall back to default
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': 'invalid' })), DEFAULT_REQUEST_TIMEOUT_MS, 'falls back to default on invalid string');
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': 'NaN' })), DEFAULT_REQUEST_TIMEOUT_MS, 'falls back to default on NaN');
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '-500' })), DEFAULT_REQUEST_TIMEOUT_MS, 'falls back to default on negative timeout');
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '0' })), DEFAULT_REQUEST_TIMEOUT_MS, 'falls back to default on zero timeout');

  // Oversized values are clamped to MAX_REQUEST_TIMEOUT_MS
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '120000' })), MAX_REQUEST_TIMEOUT_MS, 'clamps oversized timeout to MAX_REQUEST_TIMEOUT_MS');

  // Configurable max and min timeout caps
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '20000' }), 10000, 15000), 15000, 'enforces custom maxTimeoutMs');
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '500' }), 10000, 15000, 1000), 1000, 'enforces custom minTimeoutMs');
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '-500' }), 10000, 15000), 10000, 'custom default returned for negative header');

  t.end();
});

test('getDownstreamDeadlineMs uses 80% of remaining time and clamps correctly (#981)', (t) => {
  const startTime = Date.now() - 10_000;
  const deadline = getDownstreamDeadlineMs(buildRequest({ 'request-timeout': '20000' }, startTime));
  const expected = Math.floor((20_000 - 10_000) * DOWNSTREAM_DEADLINE_RATIO);
  t.equal(deadline, expected, 'uses 80% of remaining time for standard deadlines');

  // Positive remaining budget under 1ms or 1ms never rounds down to 0
  const oneMsRequest = buildRequest({ 'request-timeout': '1000' }, Date.now() - 999);
  const oneMsDeadline = getDownstreamDeadlineMs(oneMsRequest);
  t.equal(oneMsDeadline, 1, '1ms remaining budget clamps to 1ms instead of rounding down to 0');

  // Sub-millisecond remaining budget
  // Mock request where remaining is positive fractional
  const subMsRequest = {
    headers: { 'request-timeout': '1000' },
    __startTime: Date.now() - 999.5,
  } as any;
  const subMsDeadline = getDownstreamDeadlineMs(subMsRequest);
  t.ok(subMsDeadline >= 1, 'sub-millisecond remaining budget returns at least 1ms');

  // Expired budget returns 0 deterministically
  const exactExpiredRequest = buildRequest({ 'request-timeout': '1000' }, Date.now() - 1000);
  t.equal(getDownstreamDeadlineMs(exactExpiredRequest), 0, 'exactly expired budget returns 0');

  const pastExpiredRequest = buildRequest({ 'request-timeout': '1000' }, Date.now() - 5000);
  t.equal(getDownstreamDeadlineMs(pastExpiredRequest), 0, 'past-expired budget returns 0');

  t.end();
});

test('createDownstreamAbortSignal aborts immediately when deadline is exhausted', (t) => {
  const app = Fastify({ logger: false });
  const request = buildRequest({ 'request-timeout': '1000' }, Date.now() - 2000);
  const { signal } = createDownstreamAbortSignal(request, app.log, 'http://example.test/upstream');
  t.ok(signal.aborted, 'signal is aborted when no time remains');
  app.close();
  t.end();
});

test('fetchUpstream throws UpstreamTimeoutError on abort', async (t) => {
  const app = Fastify({ logger: false });
  const request = buildRequest({ 'request-timeout': '1000' }, Date.now() - 5000);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }

    await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    });

    return new Response('{}');
  }) as typeof fetch;

  try {
    await fetchUpstream(request, 'http://example.test/slow', {}, app.log);
    t.fail('expected timeout error');
  } catch (err) {
    t.ok(err instanceof UpstreamTimeoutError, 'throws UpstreamTimeoutError');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    t.end();
  }
});

test('isPrivateOrReservedHost identifies private IPs, IPv6 ULA, and obfuscated IPv4 (#979)', (t) => {
  // Localhost
  t.ok(isPrivateOrReservedHost('localhost'), 'localhost is private');
  t.ok(isPrivateOrReservedHost('sub.localhost'), 'subdomain.localhost is private');

  // Standard IPv4 private ranges
  t.ok(isPrivateOrReservedHost('127.0.0.1'), '127.0.0.1 is private');
  t.ok(isPrivateOrReservedHost('10.0.0.1'), '10.x.x.x is private');
  t.ok(isPrivateOrReservedHost('172.16.0.1'), '172.16.x.x is private');
  t.ok(isPrivateOrReservedHost('172.31.255.255'), '172.31.x.x is private');
  t.ok(isPrivateOrReservedHost('192.168.1.1'), '192.168.x.x is private');
  t.ok(isPrivateOrReservedHost('169.254.1.1'), '169.254.x.x is private');
  t.ok(isPrivateOrReservedHost('0.0.0.0'), '0.0.0.0 is private/reserved');
  t.ok(isPrivateOrReservedHost('100.64.0.1'), '100.64.x.x CGNAT is private/reserved');
  t.ok(isPrivateOrReservedHost('192.0.2.1'), 'TEST-NET-1 is reserved');
  t.ok(isPrivateOrReservedHost('198.51.100.1'), 'TEST-NET-2 is reserved');
  t.ok(isPrivateOrReservedHost('203.0.113.1'), 'TEST-NET-3 is reserved');
  t.ok(isPrivateOrReservedHost('224.0.0.1'), 'multicast is reserved');
  t.ok(isPrivateOrReservedHost('255.255.255.255'), 'broadcast is reserved');

  // IPv4 obfuscations (octal, hex, integer, shorthand)
  t.ok(isPrivateOrReservedHost('0177.0.0.1'), 'octal 0177.0.0.1 is private loopback');
  t.ok(isPrivateOrReservedHost('012.0.0.1'), 'octal 012.0.0.1 is private 10.x');
  t.ok(isPrivateOrReservedHost('0x7f000001'), 'hex 0x7f000001 is private loopback');
  t.ok(isPrivateOrReservedHost('0x7f.0.0.1'), 'dotted hex 0x7f.0.0.1 is private loopback');
  t.ok(isPrivateOrReservedHost('0x7f.1'), '2-part hex 0x7f.1 is private loopback');
  t.ok(isPrivateOrReservedHost('2130706433'), 'integer 2130706433 is private loopback');
  t.ok(isPrivateOrReservedHost('127.1'), 'shorthand 127.1 is private loopback');
  t.ok(isPrivateOrReservedHost('10.1'), 'shorthand 10.1 is private 10.x');
  t.ok(isPrivateOrReservedHost('0'), 'shorthand 0 is 0.0.0.0');

  // IPv6 loopback and unspecified
  t.ok(isPrivateOrReservedHost('::1'), 'IPv6 loopback ::1 is private');
  t.ok(isPrivateOrReservedHost('[::1]'), 'bracketed IPv6 loopback [::1] is private');
  t.ok(isPrivateOrReservedHost('::'), 'IPv6 unspecified :: is reserved');
  t.ok(isPrivateOrReservedHost('[::]'), 'bracketed IPv6 unspecified [::] is reserved');

  // IPv6 ULA (fc00::/7 including fc00:: and fd00::)
  t.ok(isPrivateOrReservedHost('fc00::1'), 'fc00::1 ULA is private');
  t.ok(isPrivateOrReservedHost('[fc00::1]'), 'bracketed [fc00::1] ULA is private');
  t.ok(isPrivateOrReservedHost('fd00::1'), 'fd00::1 ULA is private');
  t.ok(isPrivateOrReservedHost('[fd00::1]'), 'bracketed [fd00::1] ULA is private');
  t.ok(isPrivateOrReservedHost('fd12:3456:789a::1'), 'general fd00::/8 ULA is private');

  // IPv6 Link-Local (fe80::/10)
  t.ok(isPrivateOrReservedHost('fe80::1'), 'fe80::1 link-local is private');
  t.ok(isPrivateOrReservedHost('[fe80::1]'), 'bracketed [fe80::1] link-local is private');
  t.ok(isPrivateOrReservedHost('febf::1'), 'febf::1 link-local is private');

  // IPv4-mapped IPv6 (::ffff:w.x.y.z and hex format)
  t.ok(isPrivateOrReservedHost('::ffff:127.0.0.1'), '::ffff:127.0.0.1 IPv4-mapped loopback is private');
  t.ok(isPrivateOrReservedHost('[::ffff:127.0.0.1]'), 'bracketed [::ffff:127.0.0.1] is private');
  t.ok(isPrivateOrReservedHost('::ffff:10.0.0.1'), '::ffff:10.0.0.1 IPv4-mapped is private');
  t.ok(isPrivateOrReservedHost('::ffff:192.168.1.1'), '::ffff:192.168.1.1 IPv4-mapped is private');
  t.ok(isPrivateOrReservedHost('::ffff:7f00:1'), '::ffff:7f00:1 hex IPv4-mapped loopback is private');
  t.ok(isPrivateOrReservedHost('[::ffff:7f00:1]'), 'bracketed [::ffff:7f00:1] is private');

  // Allowed public hostnames and addresses
  t.notOk(isPrivateOrReservedHost('example.com'), 'public hostname is not private');
  t.notOk(isPrivateOrReservedHost('8.8.8.8'), 'public IP 8.8.8.8 is not private');
  t.notOk(isPrivateOrReservedHost('1.1.1.1'), 'public IP 1.1.1.1 is not private');
  t.notOk(isPrivateOrReservedHost('fx.betta-pay.com'), 'fx-engine hostname is not private');
  t.notOk(isPrivateOrReservedHost('2001:4860:4860::8888'), 'public IPv6 is not private');
  t.notOk(isPrivateOrReservedHost('[2001:4860:4860::8888]'), 'bracketed public IPv6 is not private');
  t.notOk(isPrivateOrReservedHost('::ffff:8.8.8.8'), 'IPv4-mapped public IP is not private');
  t.notOk(isPrivateOrReservedHost('[::ffff:8.8.8.8]'), 'bracketed IPv4-mapped public IP is not private');

  t.end();
});

test('validateUpstreamUrl rejects private host targets and bypass vectors (#979)', (t) => {
  // Standard IPv4 private addresses
  t.throws(() => validateUpstreamUrl('http://127.0.0.1/api/data'), SsrfRejectedError, 'rejects 127.0.0.1');
  t.throws(() => validateUpstreamUrl('http://10.0.0.1/api/data'), SsrfRejectedError, 'rejects 10.x');
  t.throws(() => validateUpstreamUrl('http://192.168.1.1/api/data'), SsrfRejectedError, 'rejects 192.168.x');
  t.throws(() => validateUpstreamUrl('http://localhost/api/data'), SsrfRejectedError, 'rejects localhost');
  t.throws(() => validateUpstreamUrl('ftp://example.com/api/data'), SsrfRejectedError, 'rejects ftp scheme');

  // IPv6 ULA, loopback, and link-local
  t.throws(() => validateUpstreamUrl('http://[::1]/api/data'), SsrfRejectedError, 'rejects [::1]');
  t.throws(() => validateUpstreamUrl('http://[fc00::1]/api/data'), SsrfRejectedError, 'rejects [fc00::1]');
  t.throws(() => validateUpstreamUrl('http://[fd00::1]/api/data'), SsrfRejectedError, 'rejects [fd00::1]');
  t.throws(() => validateUpstreamUrl('http://[fe80::1]/api/data'), SsrfRejectedError, 'rejects [fe80::1]');

  // IPv4-mapped IPv6
  t.throws(() => validateUpstreamUrl('http://[::ffff:127.0.0.1]/api/data'), SsrfRejectedError, 'rejects [::ffff:127.0.0.1]');

  // Obfuscated IPv4
  t.throws(() => validateUpstreamUrl('http://0177.0.0.1/api/data'), SsrfRejectedError, 'rejects octal 0177.0.0.1');
  t.throws(() => validateUpstreamUrl('http://0x7f000001/api/data'), SsrfRejectedError, 'rejects hex 0x7f000001');

  // Allowed public URLs
  t.doesNotThrow(() => validateUpstreamUrl('https://fx.betta-pay.com/api/rates'), 'accepts valid https URL');
  t.doesNotThrow(() => validateUpstreamUrl('http://fx.betta-pay.com/api/rates'), 'accepts valid http URL');
  t.doesNotThrow(() => validateUpstreamUrl('https://8.8.8.8/api/rates'), 'accepts public IPv4 URL');
  t.doesNotThrow(() => validateUpstreamUrl('https://[2001:4860:4860::8888]/api/rates'), 'accepts public IPv6 URL');

  t.end();
});

test('fetchUpstream rejects SSRF target', async (t) => {
  const app = Fastify({ logger: false });
  const request = buildRequest();

  try {
    await fetchUpstream(request, 'http://169.254.169.254/latest/meta-data', {}, app.log);
    t.fail('expected SSRF rejection');
  } catch (err) {
    t.ok(err instanceof SsrfRejectedError, 'throws SsrfRejectedError for link-local IP');
  } finally {
    await app.close();
    t.end();
  }
});
