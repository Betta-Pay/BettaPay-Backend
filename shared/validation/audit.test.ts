import test from 'node:test';
import assert from 'node:assert';
import { getClientIp } from './audit.js';

// Issue #621 — AuditLog.ipAddress used to trust X-Forwarded-For unconditionally,
// letting a direct (non-proxied) attacker spoof it and poison the audit trail.

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

test('getClientIp: 1-proxy trust only strips the single trusted hop, not entries further upstream', () => {
  // With trustedProxyCount=1 we trust that exactly one proxy appended the
  // entry immediately before our socket peer — "203.0.113.9" here. Anything
  // further left ("9.9.9.9") arrived already in the header before it ever
  // reached that trusted proxy, so it is not the resolved client, same as
  // Express/Fastify's trust proxy: N semantics — this is why the default
  // stays 0 unless the deployment topology genuinely has a proxy there.
  const request = {
    headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.9' },
    ip: '10.0.0.1',
  };
  assert.strictEqual(getClientIp(request, 1), '203.0.113.9');
});

test('getClientIp: array-valued X-Forwarded-For header is handled', () => {
  const request = {
    headers: { 'x-forwarded-for': ['203.0.113.9, 10.0.0.2'] },
    ip: '10.0.0.1',
  };
  assert.strictEqual(getClientIp(request, 2), '203.0.113.9');
});

test('getClientIp: falls back to request.ip when X-Forwarded-For is absent even with trust configured', () => {
  const request = { headers: {}, ip: '203.0.113.9' };
  assert.strictEqual(getClientIp(request, 1), '203.0.113.9');
});

test('getClientIp: X-Real-IP is only trusted when trustedProxyCount > 0', () => {
  const request = {
    headers: { 'x-real-ip': '1.1.1.1' },
    ip: '198.51.100.7',
  };
  assert.strictEqual(getClientIp(request, 0), '198.51.100.7', 'ignored when untrusted');
  assert.strictEqual(getClientIp(request, 1), '1.1.1.1', 'trusted when a proxy is configured');
});
