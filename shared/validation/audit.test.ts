import test from 'node:test';
import assert from 'node:assert';
import { getClientIp, parseTrustedProxyCount } from './audit.js';

// Issue #621 & #866 — getClientIp trusted proxy depth and spoofed header rejection.

test('parseTrustedProxyCount: parses integers and defaults invalid/negative to 0', () => {
  assert.strictEqual(parseTrustedProxyCount(undefined), 0);
  assert.strictEqual(parseTrustedProxyCount(''), 0);
  assert.strictEqual(parseTrustedProxyCount('   '), 0);
  assert.strictEqual(parseTrustedProxyCount('not-a-number'), 0);
  assert.strictEqual(parseTrustedProxyCount('-1'), 0);
  assert.strictEqual(parseTrustedProxyCount('0'), 0);
  assert.strictEqual(parseTrustedProxyCount('1'), 1);
  assert.strictEqual(parseTrustedProxyCount('2'), 2);
  assert.strictEqual(parseTrustedProxyCount('5'), 5);
});

test('getClientIp: trustedProxyCount=0 (default) ignores X-Forwarded-For and uses request.ip', () => {
  const request = {
    headers: { 'x-forwarded-for': '1.1.1.1' },
    ip: '203.0.113.9',
  };
  assert.strictEqual(getClientIp(request, 0), '203.0.113.9');
  assert.strictEqual(getClientIp(request), '203.0.113.9', 'defaults to trustedProxyCount=0');
});

test('getClientIp: spoofed X-Forwarded-For from an untrusted direct client is ignored', () => {
  // No real proxy in front — request.ip is the attacker's own address, and
  // they set X-Forwarded-For themselves trying to impersonate someone else.
  const request = {
    headers: { 'x-forwarded-for': '1.1.1.1' },
    ip: '198.51.100.7', // attacker's real address
  };
  assert.strictEqual(getClientIp(request, 0), '198.51.100.7');
});

test('getClientIp: 1-proxy chain extracts the original client through a single trusted proxy', () => {
  // real client 203.0.113.9 -> trusted LB (appends its view of the source,
  // then forwards; our socket sees the LB itself as the direct peer)
  const request = {
    headers: { 'x-forwarded-for': '203.0.113.9' },
    ip: '10.0.0.1', // the trusted LB's address
  };
  assert.strictEqual(getClientIp(request, 1), '203.0.113.9');
});

test('getClientIp: 2-proxy chain strips both trusted hops to find the original client', () => {
  // real client 203.0.113.9 -> CDN edge -> internal LB -> us.
  // X-Forwarded-For accumulates left-to-right as it passes through each hop.
  const request = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    ip: '10.0.0.1', // the internal LB's address (direct socket peer)
  };
  assert.strictEqual(getClientIp(request, 2), '203.0.113.9');
});

test('getClientIp: depth 1 selects the first hop after the proxy; depth 2 selects the second', () => {
  const request = {
    headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.20, 10.0.0.2' },
    ip: '10.0.0.1',
  };
  // Chain: [203.0.113.10, 198.51.100.20, 10.0.0.2, 10.0.0.1]
  // Depth 1 strips 10.0.0.1 -> returns 10.0.0.2
  assert.strictEqual(getClientIp(request, 1), '10.0.0.2');
  // Depth 2 strips 10.0.0.1 and 10.0.0.2 -> returns 198.51.100.20
  assert.strictEqual(getClientIp(request, 2), '198.51.100.20');
  // Depth 3 strips 10.0.0.1, 10.0.0.2, 198.51.100.20 -> returns 203.0.113.10
  assert.strictEqual(getClientIp(request, 3), '203.0.113.10');
});

test('getClientIp: forged leading X-Forwarded-For value is not returned at configured depths', () => {
  // An attacker sent 'spoofed-attacker-value' in X-Forwarded-For when contacting edge proxy 198.51.100.25.
  // The proxies appended legitimate hops:
  const request = {
    headers: { 'x-forwarded-for': 'spoofed.attacker.ip, 198.51.100.25, 10.0.0.2' },
    ip: '10.0.0.1',
  };
  // With 2 trusted proxies in the infrastructure (internal LB + edge proxy):
  const resolved = getClientIp(request, 2);
  assert.strictEqual(resolved, '198.51.100.25');
  assert.notStrictEqual(resolved, 'spoofed.attacker.ip');

  // With 1 trusted proxy (internal LB only):
  const resolved1 = getClientIp(request, 1);
  assert.strictEqual(resolved1, '10.0.0.2');
  assert.notStrictEqual(resolved1, 'spoofed.attacker.ip');

  // With 0 trusted proxies:
  const resolved0 = getClientIp(request, 0);
  assert.strictEqual(resolved0, '10.0.0.1');
  assert.notStrictEqual(resolved0, 'spoofed.attacker.ip');
});

test('getClientIp: 1-proxy trust only strips the single trusted hop, not entries further upstream', () => {
  const request = {
    headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.9' },
    ip: '10.0.0.1',
  };
  assert.strictEqual(getClientIp(request, 1), '203.0.113.9');
});

test('getClientIp: array-valued X-Forwarded-For header resolves to the same address as comma-joined equivalent', () => {
  const arrayRequest = {
    headers: { 'x-forwarded-for': ['203.0.113.9', '10.0.0.2'] },
    ip: '10.0.0.1',
  };
  const stringRequest = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    ip: '10.0.0.1',
  };
  assert.strictEqual(getClientIp(arrayRequest, 2), getClientIp(stringRequest, 2));
  assert.strictEqual(getClientIp(arrayRequest, 1), getClientIp(stringRequest, 1));
  assert.strictEqual(getClientIp(arrayRequest, 0), getClientIp(stringRequest, 0));
  assert.strictEqual(getClientIp(arrayRequest, 2), '203.0.113.9');
});

test('getClientIp: falls back to request.ip when X-Forwarded-For is absent even with trust configured', () => {
  const request = { headers: {}, ip: '203.0.113.9' };
  assert.strictEqual(getClientIp(request, 1), '203.0.113.9');
});

test('getClientIp: X-Real-IP is ignored at depth 0 and used at depth 1 when X-Forwarded-For is absent', () => {
  const request = {
    headers: { 'x-real-ip': '1.1.1.1' },
    ip: '198.51.100.7',
  };
  assert.strictEqual(getClientIp(request, 0), '198.51.100.7', 'ignored when untrusted');
  assert.strictEqual(getClientIp(request, 1), '1.1.1.1', 'trusted when a proxy is configured');

  // When X-Forwarded-For IS present, it takes precedence over X-Real-IP
  const requestWithBoth = {
    headers: {
      'x-real-ip': '1.1.1.1',
      'x-forwarded-for': '203.0.113.9',
    },
    ip: '10.0.0.1',
  };
  assert.strictEqual(getClientIp(requestWithBoth, 1), '203.0.113.9');
});

test('getClientIp: omitting argument falls back to parseTrustedProxyCount(process.env.TRUSTED_PROXY_COUNT)', () => {
  const prev = process.env.TRUSTED_PROXY_COUNT;
  const request = {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    ip: '10.0.0.1',
  };

  try {
    delete process.env.TRUSTED_PROXY_COUNT;
    assert.strictEqual(getClientIp(request), '10.0.0.1', 'defaults to 0 when env unset');

    process.env.TRUSTED_PROXY_COUNT = '2';
    assert.strictEqual(getClientIp(request), '203.0.113.9', 'reads depth 2 from env');

    process.env.TRUSTED_PROXY_COUNT = '1';
    assert.strictEqual(getClientIp(request), '10.0.0.2', 'reads depth 1 from env');

    process.env.TRUSTED_PROXY_COUNT = 'invalid';
    assert.strictEqual(getClientIp(request), '10.0.0.1', 'defaults to 0 on invalid env');
  } finally {
    if (prev !== undefined) {
      process.env.TRUSTED_PROXY_COUNT = prev;
    } else {
      delete process.env.TRUSTED_PROXY_COUNT;
    }
  }
});
