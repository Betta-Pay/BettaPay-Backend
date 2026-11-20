import test from 'node:test';
import assert from 'node:assert';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { createLoggerOptions } from './logger.js';

/** Logs `obj` through a real Pino logger built from createLoggerOptions and returns the parsed line. */
async function logThroughPino(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const app = Fastify({ logger: { ...createLoggerOptions({ pretty: false }), stream } });
  app.log.info(obj, 'redaction probe');
  await app.close();
  const line = lines.find((l) => l.includes('redaction probe'));
  assert.ok(line, 'probe line was logged');
  return JSON.parse(line);
}

test('createLoggerOptions uses an explicit level over env/default', () => {
  const opts = createLoggerOptions({ level: 'debug' });
  assert.strictEqual(opts.level, 'debug');
});

test('createLoggerOptions falls back to LOG_LEVEL env then info', () => {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  assert.strictEqual(createLoggerOptions().level, 'warn');

  delete process.env.LOG_LEVEL;
  assert.strictEqual(createLoggerOptions().level, 'info', 'defaults to info');

  if (prev !== undefined) process.env.LOG_LEVEL = prev;
});

test('createLoggerOptions redacts sensitive fields', () => {
  const { redact } = createLoggerOptions();
  const paths = redact.paths;
  for (const field of ['secret', 'token', 'secretHash', 'password', 'authorization']) {
    assert.ok(
      paths.some((p) => p === field || p.endsWith(`.${field}`) || p.includes(field)),
      `redacts ${field}`,
    );
  }
  assert.strictEqual(redact.censor, '[REDACTED]');
});

test('createLoggerOptions provides compact req/res serializers', () => {
  const { serializers } = createLoggerOptions();
  const req = serializers.req({ method: 'GET', url: '/x', id: 'r1', ip: '127.0.0.1' });
  assert.deepStrictEqual(Object.keys(req).sort(), ['method', 'remoteAddress', 'requestId', 'url']);
  const res = serializers.res({ statusCode: 204 });
  assert.deepStrictEqual(res, { statusCode: 204 });
});

test('createLoggerOptions emits JSON (no transport) in production', () => {
  const opts = createLoggerOptions({ pretty: false });
  assert.strictEqual(opts.transport, undefined, 'no pretty transport when pretty=false');
});

test('Pino redacts signingSecret, apiKey, cookie and set-cookie (#1081)', async () => {
  const logged = await logThroughPino({
    signingSecret: 'whsec_top',
    apiKey: 'bp_live_top',
    cookie: 'session=top',
    'set-cookie': ['session=top; HttpOnly'],
    subscription: { id: 'sub_1', url: 'https://example.com/hook', signingSecret: 'whsec_nested' },
    merchant: { id: 'm_1', apiKey: 'bp_live_nested' },
    event: { subscription: { signingSecret: 'whsec_deep', apiKey: 'bp_live_deep' } },
    headers: {
      cookie: 'session=hdr',
      'set-cookie': 'session=hdr; HttpOnly',
      'x-api-key': 'bp_live_hdr',
      'content-type': 'application/json',
    },
  });

  assert.strictEqual(logged.signingSecret, '[REDACTED]');
  assert.strictEqual(logged.apiKey, '[REDACTED]');
  assert.strictEqual(logged.cookie, '[REDACTED]');
  assert.strictEqual(logged['set-cookie'], '[REDACTED]');

  const subscription = logged.subscription as Record<string, unknown>;
  assert.strictEqual(subscription.signingSecret, '[REDACTED]');
  assert.strictEqual(subscription.url, 'https://example.com/hook', 'non-secret fields are kept');
  assert.strictEqual((logged.merchant as Record<string, unknown>).apiKey, '[REDACTED]');

  const deep = (logged.event as Record<string, Record<string, unknown>>).subscription;
  assert.strictEqual(deep.signingSecret, '[REDACTED]');
  assert.strictEqual(deep.apiKey, '[REDACTED]');

  const headers = logged.headers as Record<string, unknown>;
  assert.strictEqual(headers.cookie, '[REDACTED]');
  assert.strictEqual(headers['set-cookie'], '[REDACTED]');
  assert.strictEqual(headers['x-api-key'], '[REDACTED]');
  assert.strictEqual(headers['content-type'], 'application/json');

  const serialized = JSON.stringify(logged);
  for (const leaked of ['whsec_', 'bp_live_', 'session=']) {
    assert.ok(!serialized.includes(leaked), `no ${leaked} value leaks into the log line`);
  }
});

test('Pino redaction keeps existing log formatting intact (#1081)', async () => {
  const logged = await logThroughPino({ secret: 's', password: 'p', merchantId: 'm_1', amount: '10.00' });
  assert.strictEqual(logged.msg, 'redaction probe');
  assert.strictEqual(logged.level, 30);
  assert.strictEqual(logged.secret, '[REDACTED]');
  assert.strictEqual(logged.password, '[REDACTED]');
  assert.strictEqual(logged.merchantId, 'm_1');
  assert.strictEqual(logged.amount, '10.00');
});
