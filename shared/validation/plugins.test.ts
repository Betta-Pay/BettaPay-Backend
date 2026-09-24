import test from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { z } from 'zod';
import { registerErrorHandler, registerServiceAuth, createServiceAuth, redactPiiFromDetails, sanitizeErrorMessage, buildCsrfCookieHeader } from './plugins.js';

test('Zod validation error returns 400 with reqId', async (t) => {
  const fastify = Fastify({ logger: false });
  registerErrorHandler(fastify);

  const schema = z.object({ age: z.number() });

  fastify.post('/', (req, reply) => {
    schema.parse(req.body);
    reply.send({ ok: true });
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/',
    payload: { age: 'not a number' }
  });

  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
  assert.strictEqual(body.error.message, 'Invalid request data');
  assert.ok(Array.isArray(body.error.details));
  assert.ok(body.error.reqId, 'reqId is present in validation error response');
});

test('Fastify error returns expected status code and preserves message with reqId', async (t) => {
  const fastify = Fastify({ logger: false });
  registerErrorHandler(fastify);

  fastify.get('/', () => {
    const err: any = new Error('Rate limit exceeded');
    err.statusCode = 429;
    err.code = 'RATE_LIMIT';
    throw err;
  });

  const response = await fastify.inject({ method: 'GET', url: '/' });

  assert.strictEqual(response.statusCode, 429);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error.code, 'RATE_LIMIT');
  assert.strictEqual(body.error.message, 'Rate limit exceeded');
  assert.ok(body.error.reqId, 'reqId is present in Fastify error response');
});

test('Generic error returns 500 and does not leak stack trace with reqId', async (t) => {
  const fastify = Fastify({ logger: false });
  
  let logged = false;
  const mockLogger: any = {
    error: () => { logged = true; },
    info: () => {},
    warn: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => mockLogger
  };
  
  registerErrorHandler(fastify, mockLogger);

  fastify.get('/', () => {
    throw new Error('Database connection failed');
  });

  const response = await fastify.inject({ method: 'GET', url: '/' });

  assert.strictEqual(response.statusCode, 500);
  const body = JSON.parse(response.body);
  // Generic fallback shape (with referenceId for error tracking), not the
  // standard error envelope — no internal details are exposed.
  assert.strictEqual(body.error, 'Internal Server Error');
  assert.strictEqual(body.statusCode, 500);
  assert.ok(body.referenceId, 'referenceId is present for traceability');
  assert.ok(body.reqId, 'reqId is present in generic error response');
  assert.strictEqual(body.details, undefined);
  assert.strictEqual(response.body.includes('Database connection failed'), false);
  assert.strictEqual(logged, true, 'Logger should be called when error occurs');
});

const SERVICE_SECRET = 'shared-inter-service-secret';

function buildServiceAuthApp() {
  const app = Fastify({ logger: false });
  registerServiceAuth(app, SERVICE_SECRET);
  app.get('/internal', { preValidation: [app.serviceAuth] }, async () => ({ ok: true }));
  return app;
}

test('serviceAuth rejects a request without x-service-token', async () => {
  const app = buildServiceAuthApp();
  const res = await app.inject({ method: 'GET', url: '/internal' });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(JSON.parse(res.body).error.code, 'UNAUTHORIZED');
});

test('serviceAuth rejects an invalid x-service-token', async () => {
  const app = buildServiceAuthApp();
  const res = await app.inject({ method: 'GET', url: '/internal', headers: { 'x-service-token': 'nope' } });
  assert.strictEqual(res.statusCode, 401);
});

test('serviceAuth accepts a valid x-service-token', async () => {
  const app = buildServiceAuthApp();
  const res = await app.inject({ method: 'GET', url: '/internal', headers: { 'x-service-token': SERVICE_SECRET } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).ok, true);
});

test('serviceAuth accepts either key during rotation window (two overlapping keys)', async () => {
  const oldSecret = 'old-inter-service-secret-key';
  const newSecret = 'new-inter-service-secret-key';
  const app = Fastify({ logger: false });
  registerServiceAuth(app, [oldSecret, newSecret]);
  app.get('/internal', { preValidation: [app.serviceAuth] }, async () => ({ ok: true }));

  const resOld = await app.inject({ method: 'GET', url: '/internal', headers: { 'x-service-token': oldSecret } });
  assert.strictEqual(resOld.statusCode, 200, 'old key accepted during rotation');

  const resNew = await app.inject({ method: 'GET', url: '/internal', headers: { 'x-service-token': newSecret } });
  assert.strictEqual(resNew.statusCode, 200, 'new key accepted during rotation');

  const resInvalid = await app.inject({ method: 'GET', url: '/internal', headers: { 'x-service-token': 'neither-key' } });
  assert.strictEqual(resInvalid.statusCode, 401, 'invalid key rejected during rotation');

  await app.close();
});

test('createServiceAuth throws when given an empty array', () => {
  assert.throws(
    () => createServiceAuth([]),
    /at least one non-empty/,
    'fails fast on empty array',
  );
});

test('createServiceAuth throws when array contains empty strings', () => {
  assert.throws(
    () => createServiceAuth(['valid-key', '']),
    /at least one non-empty/,
    'fails fast on array with empty string',
  );
});

test('redactPiiFromDetails redacts email field messages', () => {
  const details = [{ path: ['email'], message: 'user@example.com is invalid' }];
  const result = redactPiiFromDetails(details) as any;
  assert.strictEqual(result[0].message, '[REDACTED]');
});

test('redactPiiFromDetails redacts secret key field messages', () => {
  const details = [{ path: ['secretKey'], message: 'sk_live_abc123 is invalid' }];
  const result = redactPiiFromDetails(details) as any;
  assert.strictEqual(result[0].message, '[REDACTED]');
});

test('redactPiiFromDetails preserves non-PII field messages', () => {
  const details = [{ path: ['amount'], message: 'Must be a positive number' }];
  const result = redactPiiFromDetails(details) as any;
  assert.strictEqual(result[0].message, 'Must be a positive number');
});

test('redactPiiFromDetails preserves error structure', () => {
  const details = [
    { path: ['email'], message: 'user@example.com is invalid' },
    { path: ['amount'], message: 'Must be a positive number' },
    { path: ['secretKey'], message: 'sk_live_abc123 is invalid' },
  ];
  const result = redactPiiFromDetails(details) as any;
  assert.strictEqual(result[0].message, '[REDACTED]');
  assert.strictEqual(result[1].message, 'Must be a positive number');
  assert.strictEqual(result[2].message, '[REDACTED]');
  assert.strictEqual(result.length, 3);
});

test('Zod error handler redacts PII from response', async (t) => {
  const fastify = Fastify({ logger: false });
  registerErrorHandler(fastify);
  const schema = z.object({ email: z.string().email() });
  fastify.post('/', (req, reply) => {
    schema.parse(req.body);
    reply.send({ ok: true });
  });
  const response = await fastify.inject({
    method: 'POST',
    url: '/',
    payload: { email: 'not-an-email' }
  });
  assert.strictEqual(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error.details[0].message, '[REDACTED]');
});

test('error handler does not leak PII in message', async (t) => {
  const fastify = Fastify({ logger: false });
  registerErrorHandler(fastify);
  fastify.post('/', (req, reply) => {
    const schema = z.object({
      email: z.string().refine(() => false, { message: 'user@example.com is invalid' })
    });
    schema.parse(req.body);
    reply.send({ ok: true });
  });
  const response = await fastify.inject({
    method: 'POST',
    url: '/',
    payload: { email: 'anything' }
  });
  const body = JSON.parse(response.body);
  assert.strictEqual(body.error.details[0].message, '[REDACTED]');
  assert.strictEqual(response.body.includes('user@example.com'), false);
});

test('sanitizeErrorMessage strips file paths', () => {
  const result = sanitizeErrorMessage('Error at /home/user/app/src/index.ts:42');
  assert.ok(!result.includes('/home/user/app/src/index.ts'), 'file path should be filtered');
});

test('sanitizeErrorMessage strips connection strings', () => {
  const result = sanitizeErrorMessage('ECONNREFUSED 127.0.0.1:5432');
  assert.ok(!result.includes('ECONNREFUSED'), 'connection error should be filtered');
});

test('sanitizeErrorMessage strips node_modules paths', () => {
  const result = sanitizeErrorMessage('Error in node_modules/zod/src/index.ts');
  assert.ok(!result.includes('node_modules'), 'node_modules path should be filtered');
});

test('sanitizeErrorMessage preserves safe messages', () => {
  const result = sanitizeErrorMessage('Rate limit exceeded');
  assert.strictEqual(result, 'Rate limit exceeded');
});

test('Fastify error handler sanitizes internal messages', async (t) => {
  const fastify = Fastify({ logger: false });
  registerErrorHandler(fastify);

  fastify.get('/', () => {
    const err: any = new Error('Connection to postgresql://user:password@host:5432/db refused');
    err.statusCode = 503;
    err.code = 'UPSTREAM_ERROR';
    throw err;
  });

  const response = await fastify.inject({ method: 'GET', url: '/' });
  assert.strictEqual(response.statusCode, 503);
  const body = JSON.parse(response.body);
  assert.ok(!body.error.message.includes('postgresql'), 'connection string should be sanitized');
  assert.ok(!body.error.message.includes('password'), 'password should be sanitized');
});

test('buildCsrfCookieHeader sets Secure when request is HTTPS (#560)', () => {
  const header = buildCsrfCookieHeader('csrf', 'abc123', { protocol: 'https' });
  assert.ok(header.includes('Secure'), 'HTTPS request should set Secure flag');
  assert.ok(header.includes('HttpOnly'), 'cookie should be HttpOnly');
  assert.ok(header.includes('SameSite=Strict'), 'cookie should be SameSite=Strict');
  assert.ok(header.includes('Path=/'), 'cookie should have Path=/');
});

test('buildCsrfCookieHeader omits Secure when request is HTTP (#560)', () => {
  const header = buildCsrfCookieHeader('csrf', 'abc123', { protocol: 'http' });
  assert.ok(!header.includes('Secure'), 'HTTP request should not set Secure flag');
});

test('buildCsrfCookieHeader detects HTTPS from x-forwarded-proto header (#560)', () => {
  const header = buildCsrfCookieHeader('csrf', 'abc123', {
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.ok(header.includes('Secure'), 'x-forwarded-proto: https should set Secure flag');
});

test('buildCsrfCookieHeader omits Secure when x-forwarded-proto is http (#560)', () => {
  const header = buildCsrfCookieHeader('csrf', 'abc123', {
    headers: { 'x-forwarded-proto': 'http' },
  });
  assert.ok(!header.includes('Secure'), 'x-forwarded-proto: http should not set Secure flag');
});

test('buildCsrfCookieHeader uses correct name and value (#560)', () => {
  const header = buildCsrfCookieHeader('myCsrf', 'token-value', { protocol: 'https' });
  assert.ok(header.startsWith('myCsrf=token-value'), 'cookie should start with name=value');
});
