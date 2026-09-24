import test from 'tape';
import Fastify from 'fastify';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
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

test('getRequestTimeoutMs reads Request-Timeout header', (t) => {
  t.equal(getRequestTimeoutMs(buildRequest()), DEFAULT_REQUEST_TIMEOUT_MS);
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': '5000' })), 5000);
  t.equal(getRequestTimeoutMs(buildRequest({ 'request-timeout': 'invalid' })), DEFAULT_REQUEST_TIMEOUT_MS);
  t.end();
});

test('getDownstreamDeadlineMs uses 80% of remaining time', (t) => {
  const startTime = Date.now() - 10_000;
  const deadline = getDownstreamDeadlineMs(buildRequest({ 'request-timeout': '20000' }, startTime));
  const expected = Math.floor((20_000 - 10_000) * DOWNSTREAM_DEADLINE_RATIO);
  t.equal(deadline, expected);
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

test('isPrivateOrReservedHost identifies private IPs and localhost', (t) => {
  t.ok(isPrivateOrReservedHost('localhost'), 'localhost is private');
  t.ok(isPrivateOrReservedHost('127.0.0.1'), '127.0.0.1 is private');
  t.ok(isPrivateOrReservedHost('10.0.0.1'), '10.x.x.x is private');
  t.ok(isPrivateOrReservedHost('172.16.0.1'), '172.16-31.x.x is private');
  t.ok(isPrivateOrReservedHost('192.168.1.1'), '192.168.x.x is private');
  t.ok(isPrivateOrReservedHost('169.254.1.1'), '169.254.x.x is private');
  t.ok(isPrivateOrReservedHost('::1'), 'IPv6 loopback is private');
  t.ok(isPrivateOrReservedHost('fc00::1'), 'fc00::/7 is private');
  t.ok(isPrivateOrReservedHost('fe80::1'), 'fe80::/10 is link-local');
  t.notOk(isPrivateOrReservedHost('example.com'), 'public hostname is not private');
  t.notOk(isPrivateOrReservedHost('8.8.8.8'), 'public IP is not private');
  t.notOk(isPrivateOrReservedHost('fx.betta-pay.com'), 'fx-engine hostname is not private');
  t.end();
});

test('validateUpstreamUrl rejects private host targets', (t) => {
  t.throws(() => validateUpstreamUrl('http://127.0.0.1/api/data'), SsrfRejectedError, 'rejects 127.0.0.1');
  t.throws(() => validateUpstreamUrl('http://10.0.0.1/api/data'), SsrfRejectedError, 'rejects 10.x');
  t.throws(() => validateUpstreamUrl('http://192.168.1.1/api/data'), SsrfRejectedError, 'rejects 192.168.x');
  t.throws(() => validateUpstreamUrl('http://localhost/api/data'), SsrfRejectedError, 'rejects localhost');
  t.throws(() => validateUpstreamUrl('ftp://example.com/api/data'), SsrfRejectedError, 'rejects ftp scheme');
  t.doesNotThrow(() => validateUpstreamUrl('https://fx.betta-pay.com/api/rates'), 'accepts valid https URL');
  t.doesNotThrow(() => validateUpstreamUrl('http://fx.betta-pay.com/api/rates'), 'accepts valid http URL');
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
