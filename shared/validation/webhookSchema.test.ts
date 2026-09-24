import test, { mock } from 'node:test';
import assert from 'node:assert';
import dns from 'node:dns';
import { Redis } from 'ioredis';
import {
  createWebhookUrlSchema,
  WebhookUrlSchema,
  checkWebhookRateLimit,
  resolveWithCache,
  clearDnsCache,
  validateWebhookUrl,
  WEBHOOK_VALIDATE_RATE_LIMIT,
  WebhookPayloadSchema,
  WebhookHeadersSchema,
} from './webhookSchema.js';

test('createWebhookUrlSchema - format & length rules apply in every environment', async (t) => {
  await t.test('rejects a non-URL string', () => {
    const schema = createWebhookUrlSchema('production');
    assert.throws(() => schema.parse('not-a-url'), /valid URL/);
  });

  await t.test('rejects a URL exceeding 2048 characters', () => {
    const schema = createWebhookUrlSchema('development');
    const long = 'https://example.com/' + 'a'.repeat(2048);
    assert.throws(() => schema.parse(long), /2048/);
  });
});

test('createWebhookUrlSchema - production mode', async (t) => {
  const schema = createWebhookUrlSchema('production');

  await t.test('accepts a public HTTPS URL', () => {
    const result = schema.parse('https://example.com/hook');
    assert.strictEqual(result, 'https://example.com/hook');
  });

  await t.test('rejects HTTP URLs', () => {
    assert.throws(() => schema.parse('http://example.com/hook'), /HTTPS/);
  });

  await t.test('rejects localhost', () => {
    assert.throws(() => schema.parse('https://localhost/hook'), /localhost|private/);
  });

  await t.test('rejects 127.0.0.1', () => {
    assert.throws(() => schema.parse('https://127.0.0.1/hook'), /localhost|private/);
  });

  await t.test('rejects private IP range 192.168.x.x', () => {
    assert.throws(() => schema.parse('https://192.168.1.1/hook'), /localhost|private/);
  });

  await t.test('rejects private IP range 10.x.x.x', () => {
    assert.throws(() => schema.parse('https://10.0.0.1/hook'), /localhost|private/);
  });

  await t.test('rejects private IP range 172.16-31.x.x', () => {
    assert.throws(() => schema.parse('https://172.16.0.1/hook'), /localhost|private/);
  });

  await t.test('accepts a public IP address', () => {
    const result = schema.parse('https://93.184.216.34/hook');
    assert.strictEqual(result, 'https://93.184.216.34/hook');
  });
});

test('createWebhookUrlSchema - development mode', async (t) => {
  const schema = createWebhookUrlSchema('development');

  await t.test('accepts HTTP URLs', () => {
    const result = schema.parse('http://example.com/hook');
    assert.strictEqual(result, 'http://example.com/hook');
  });

  await t.test('accepts HTTPS URLs', () => {
    const result = schema.parse('https://example.com/hook');
    assert.strictEqual(result, 'https://example.com/hook');
  });

  await t.test('accepts localhost', () => {
    const result = schema.parse('http://localhost:3000/hook');
    assert.strictEqual(result, 'http://localhost:3000/hook');
  });
});

test('WebhookUrlSchema (default export)', async (t) => {
  await t.test('is a usable schema instance', () => {
    const result = WebhookUrlSchema.safeParse('https://example.com/hook');
    assert.strictEqual(result.success, true);
  });

  await t.test('still rejects malformed URLs regardless of environment', () => {
    const result = WebhookUrlSchema.safeParse('not-a-url');
    assert.strictEqual(result.success, false);
  });
});

class MockRedis {
  private store = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const val = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, val);
    return val;
  }
  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }
}

test('checkWebhookRateLimit', async (t) => {
  await t.test('allows up to WEBHOOK_VALIDATE_RATE_LIMIT requests', async () => {
    const mockRedis = new MockRedis() as unknown as Redis;
    const ip = '10.0.0.1';
    for (let i = 0; i < WEBHOOK_VALIDATE_RATE_LIMIT; i++) {
      assert.strictEqual(await checkWebhookRateLimit(mockRedis, ip), true);
    }
  });

  await t.test('blocks request exceeding the limit', async () => {
    const mockRedis = new MockRedis() as unknown as Redis;
    const ip = '10.0.0.2';
    for (let i = 0; i < WEBHOOK_VALIDATE_RATE_LIMIT; i++) {
      await checkWebhookRateLimit(mockRedis, ip);
    }
    assert.strictEqual(await checkWebhookRateLimit(mockRedis, ip), false);
  });

  await t.test('uses separate counters for different IPs', async () => {
    const mockRedis = new MockRedis() as unknown as Redis;
    const ip1 = '10.0.0.3';
    const ip2 = '10.0.0.4';
    for (let i = 0; i < WEBHOOK_VALIDATE_RATE_LIMIT; i++) {
      await checkWebhookRateLimit(mockRedis, ip1);
    }
    assert.strictEqual(await checkWebhookRateLimit(mockRedis, ip1), false);
    assert.strictEqual(await checkWebhookRateLimit(mockRedis, ip2), true);
  });
});

test('resolveWithCache', async (t) => {
  await t.test('caches DNS results and returns cached within TTL', async () => {
    clearDnsCache();
    const url = 'https://example.com/hook';
    const mockMethod = mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34']);

    const first = await resolveWithCache(url);
    assert.deepStrictEqual(first, ['93.184.216.34']);
    assert.strictEqual(mockMethod.mock.callCount(), 1);

    const second = await resolveWithCache(url);
    assert.deepStrictEqual(second, ['93.184.216.34']);
    assert.strictEqual(mockMethod.mock.callCount(), 1);

    mockMethod.mock.restore();
  });

  await t.test('returns empty array on DNS failure', async () => {
    clearDnsCache();
    const url = 'https://invalid.example.com/hook';
    const mockMethod = mock.method(dns.promises, 'resolve4', async () => { throw new Error('ENOTFOUND'); });

    const result = await resolveWithCache(url);
    assert.deepStrictEqual(result, []);

    mockMethod.mock.restore();
  });
});

test('validateWebhookUrl', async (t) => {
  await t.test('returns 429 when rate limited', async () => {
    clearDnsCache();
    const ip = '10.0.0.5';
    const mockRedis = new MockRedis() as unknown as Redis;
    for (let i = 0; i < WEBHOOK_VALIDATE_RATE_LIMIT; i++) {
      await checkWebhookRateLimit(mockRedis, ip);
    }

    const result = await validateWebhookUrl('https://example.com/hook', mockRedis, ip);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.statusCode, 429);
    assert.strictEqual(result.error, 'Rate limit exceeded. Please try again later.');
  });

  await t.test('returns valid=true for reachable 2xx URL', async () => {
    clearDnsCache();
    const ip = '10.0.0.6';
    const mockRedis = new MockRedis() as unknown as Redis;
    const mockDns = mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34']);
    const mockFetch: typeof globalThis.fetch = async (_url, _init) => new Response(null, { status: 200 });

    const result = await validateWebhookUrl('https://example.com/hook', mockRedis, ip, { fetch: mockFetch });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.statusCode, 200);

    mockDns.mock.restore();
  });

  await t.test('returns error for unreachable URL (fetch throws)', async () => {
    clearDnsCache();
    const ip = '10.0.0.7';
    const mockRedis = new MockRedis() as unknown as Redis;
    const mockDns = mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34']);
    const mockFetch: typeof globalThis.fetch = async (_url, _init) => { throw new Error('Connection refused'); };

    const result = await validateWebhookUrl('https://example.com/hook', mockRedis, ip, { fetch: mockFetch });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.statusCode, 400);
    assert.strictEqual(result.error, 'Webhook URL is not reachable');

    mockDns.mock.restore();
  });

  await t.test('returns error for non-2xx response', async () => {
    clearDnsCache();
    const ip = '10.0.0.8';
    const mockRedis = new MockRedis() as unknown as Redis;
    const mockDns = mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34']);
    const mockFetch: typeof globalThis.fetch = async (_url, _init) => new Response(null, { status: 500 });

    const result = await validateWebhookUrl('https://example.com/hook', mockRedis, ip, { fetch: mockFetch });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.statusCode, 500);

    mockDns.mock.restore();
  });
});

test('WebhookPayloadSchema', async (t) => {
  await t.test('accepts valid payload with version', () => {
    const payload = {
      version: '1.0',
      event: { id: 'evt_123', type: 'PaymentInitiated' },
    };
    const result = WebhookPayloadSchema.safeParse(payload);
    assert.strictEqual(result.success, true);
  });

  await t.test('rejects payload missing version', () => {
    const payload = {
      event: { id: 'evt_123', type: 'PaymentInitiated' },
    };
    const result = WebhookPayloadSchema.safeParse(payload);
    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.match(result.error.issues[0].message, /Required|version/i);
    }
  });

  await t.test('rejects payload missing event', () => {
    const payload = {
      version: '1.0',
    };
    const result = WebhookPayloadSchema.safeParse(payload);
    assert.strictEqual(result.success, false);
  });
});

// #569 — configurable custom headers per webhook subscription
test('WebhookHeadersSchema', async (t) => {
  await t.test('accepts a valid map of custom headers', () => {
    const result = WebhookHeadersSchema.safeParse({
      'Idempotency-Key': 'idem_abc123',
      'X-Merchant-Auth': 'Bearer merchant-token',
    });
    assert.strictEqual(result.success, true);
  });

  await t.test('accepts an empty header map', () => {
    const result = WebhookHeadersSchema.safeParse({});
    assert.strictEqual(result.success, true);
  });

  await t.test('rejects Content-Type as a custom header (case-insensitive)', () => {
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'Content-Type': 'text/plain' }).success, false);
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'content-type': 'text/plain' }).success, false);
  });

  await t.test('rejects X-BettaPay-Signature as a custom header (case-insensitive)', () => {
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'X-BettaPay-Signature': 'forged' }).success, false);
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'x-bettapay-signature': 'forged' }).success, false);
  });

  await t.test('rejects header names with invalid characters', () => {
    const result = WebhookHeadersSchema.safeParse({ 'Bad Header Name': 'value' });
    assert.strictEqual(result.success, false);
  });

  await t.test('rejects header values containing line breaks (header injection) (#607)', () => {
    // The exact attack shape from #607's acceptance criteria.
    const result = WebhookHeadersSchema.safeParse({ 'X-Ok': 'a\r\nInjected: b' });
    assert.strictEqual(result.success, false);
  });

  await t.test('rejects Host as a custom header (case-insensitive) (#607)', () => {
    assert.strictEqual(WebhookHeadersSchema.safeParse({ Host: 'evil.example.com' }).success, false);
    assert.strictEqual(WebhookHeadersSchema.safeParse({ host: 'evil.example.com' }).success, false);
  });

  await t.test('rejects Content-Length as a custom header (case-insensitive) (#607)', () => {
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'Content-Length': '0' }).success, false);
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'content-length': '0' }).success, false);
  });

  await t.test('rejects Transfer-Encoding and Connection as custom headers (#607)', () => {
    assert.strictEqual(WebhookHeadersSchema.safeParse({ 'Transfer-Encoding': 'chunked' }).success, false);
    assert.strictEqual(WebhookHeadersSchema.safeParse({ Connection: 'keep-alive' }).success, false);
  });

  await t.test('valid headers round-trip unchanged (#607)', () => {
    const result = WebhookHeadersSchema.safeParse({ 'X-Ok': 'a normal value', 'X-Idempotency-Key': 'abc123' });
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.deepStrictEqual(result.data, { 'X-Ok': 'a normal value', 'X-Idempotency-Key': 'abc123' });
    }
  });

  await t.test('rejects more than 20 custom headers', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 21; i++) tooMany[`X-Header-${i}`] = 'v';
    const result = WebhookHeadersSchema.safeParse(tooMany);
    assert.strictEqual(result.success, false);
  });

  await t.test('rejects a header value exceeding 4096 characters', () => {
    const result = WebhookHeadersSchema.safeParse({ 'X-Long': 'a'.repeat(4097) });
    assert.strictEqual(result.success, false);
  });
});