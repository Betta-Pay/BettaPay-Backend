import test from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';
import { FastifyRequest } from 'fastify';
import { IncomingMessage } from 'http';
import { genReqId, registerRequestId } from './index.js';
import {
  registerRequestId as directRegisterRequestId,
} from './fastify-plugins.js';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('request-id exports: registerRequestId is exported from index and fastify-plugins', () => {
  assert.strictEqual(registerRequestId, directRegisterRequestId);
  assert.strictEqual(typeof registerRequestId, 'function');
  assert.strictEqual(typeof genReqId, 'function');
});

test('genReqId - header present returns supplied request ID', () => {
  const req = {
    headers: {
      'x-request-id': 'custom-id-123',
    },
  } as unknown as FastifyRequest;

  const result = genReqId(req);
  assert.strictEqual(result, 'custom-id-123');

  const rawReq = {
    headers: {
      'x-request-id': 'raw-id-456',
    },
  } as unknown as IncomingMessage;

  const rawResult = genReqId(rawReq);
  assert.strictEqual(rawResult, 'raw-id-456');

  // Array header returns first element
  const arrayReq = {
    headers: {
      'x-request-id': ['array-id-1', 'array-id-2'],
    },
  } as unknown as FastifyRequest;
  assert.strictEqual(genReqId(arrayReq), 'array-id-1');
});

test('genReqId - missing header falls back to crypto.randomUUID()', () => {
  const req = {
    headers: {},
  } as unknown as FastifyRequest;

  const result = genReqId(req);
  assert.match(result, UUID_V4_REGEX);

  const rawReq = {
    headers: {},
  } as unknown as IncomingMessage;

  const rawResult = genReqId(rawReq);
  assert.match(rawResult, UUID_V4_REGEX);
});

test('registerRequestId: provided request ID is preserved unchanged and echoed on response', async () => {
  const app = Fastify({ logger: false });
  registerRequestId(app);

  let capturedRequestId: string | undefined;

  app.get('/test-preserve', async (request) => {
    capturedRequestId = request.id;
    return { ok: true, id: request.id };
  });

  const customId = 'client-trace-id-xyz-987';
  const response = await app.inject({
    method: 'GET',
    url: '/test-preserve',
    headers: {
      'x-request-id': customId,
    },
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(capturedRequestId, customId, 'request.id must match provided header');
  assert.strictEqual(
    response.headers['x-request-id'],
    customId,
    'x-request-id response header must preserve the provided request ID',
  );
  assert.deepStrictEqual(JSON.parse(response.body), { ok: true, id: customId });
});

test('registerRequestId: missing request ID generates a valid UUID v4 and attaches to response', async () => {
  const app = Fastify({ logger: false });
  registerRequestId(app);

  let capturedRequestId: string | undefined;

  app.get('/test-generate', async (request) => {
    capturedRequestId = request.id;
    return { ok: true, id: request.id };
  });

  const response = await app.inject({
    method: 'GET',
    url: '/test-generate',
  });

  assert.strictEqual(response.statusCode, 200);
  assert.ok(capturedRequestId, 'request.id must be set');
  assert.match(capturedRequestId, UUID_V4_REGEX, 'generated request.id must be a UUID v4');
  assert.strictEqual(
    response.headers['x-request-id'],
    capturedRequestId,
    'x-request-id response header must match the generated request.id',
  );
});

test('registerRequestId: handles array-valued x-request-id header by picking the first element', async () => {
  const app = Fastify({ logger: false });
  // Simulate reverse-proxy or middleware that parses multi-header into an array on req.headers
  app.addHook('onRequest', async (req) => {
    (req.raw.headers as any)['x-request-id'] = ['first-id-abc', 'second-id-def'];
    (req.headers as any)['x-request-id'] = ['first-id-abc', 'second-id-def'];
  });
  registerRequestId(app);

  let capturedRequestId: string | undefined;

  app.get('/test-array-header', async (request) => {
    capturedRequestId = request.id;
    return { ok: true };
  });

  const response = await app.inject({
    method: 'GET',
    url: '/test-array-header',
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(capturedRequestId, 'first-id-abc');
  assert.strictEqual(response.headers['x-request-id'], 'first-id-abc');
});

test('registerRequestId: attaches requestId to request log context via child logger', async () => {
  const loggedMessages: Array<{ bindings: any; msg: string }> = [];

  const createMockLogger = (bindings: Record<string, any> = {}) => ({
    bindings,
    info: (objOrMsg: any, maybeMsg?: string) => {
      const msg = typeof objOrMsg === 'string' ? objOrMsg : maybeMsg || '';
      loggedMessages.push({ bindings, msg });
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: (newBindings: Record<string, any>) =>
      createMockLogger({ ...bindings, ...newBindings }),
    level: 'info',
  });

  const rootLogger = createMockLogger();
  const app = Fastify({ loggerInstance: rootLogger as any });
  registerRequestId(app);

  const customId = 'log-context-req-id-123';

  app.get('/test-log-context', async (request) => {
    request.log.info('handled request in route');
    return { ok: true };
  });

  const response = await app.inject({
    method: 'GET',
    url: '/test-log-context',
    headers: {
      'x-request-id': customId,
    },
  });

  assert.strictEqual(response.statusCode, 200);
  assert.ok(loggedMessages.length > 0, 'route log was invoked');
  const routeLog = loggedMessages.find((entry) => entry.msg === 'handled request in route');
  assert.ok(routeLog, 'expected log entry found');
  assert.strictEqual(
    routeLog.bindings.requestId,
    customId,
    'log context must have requestId attached matching the request ID',
  );
});
