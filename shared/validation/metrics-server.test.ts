import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveMetricsPort, startMetricsServer } from './metrics-server.js';

// Issue #864: Unit tests for startMetricsServer scrape-token auth branch and listener behavior.

interface HttpResponse {
  status: number;
  contentType?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  headers?: Record<string, string>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    // agent: false + Connection: close avoids a keep-alive socket lingering
    // past this request — each test binds its own ephemeral (port 0) server.
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: { Connection: 'close', ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'],
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function get(port: number, path: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return request(port, 'GET', path, headers);
}

function createLogSpy() {
  const infoCalls: { obj: object; msg?: string }[] = [];
  const errorCalls: { obj: object; msg?: string }[] = [];
  return {
    infoCalls,
    errorCalls,
    info(obj: object, msg?: string) {
      infoCalls.push({ obj, msg });
    },
    error(obj: object, msg?: string) {
      errorCalls.push({ obj, msg });
    },
  };
}

test('resolveMetricsPort: defaults to appPort + 1000 when METRICS_PORT is unset', () => {
  delete process.env.METRICS_PORT;
  assert.equal(resolveMetricsPort(3000), 4000);
  assert.equal(resolveMetricsPort(3002), 4002);
});

test('resolveMetricsPort: honors METRICS_PORT override when set to a valid number', () => {
  process.env.METRICS_PORT = '9100';
  assert.equal(resolveMetricsPort(3000), 9100);
  delete process.env.METRICS_PORT;
});

test('resolveMetricsPort: falls back to the default for an invalid METRICS_PORT', () => {
  process.env.METRICS_PORT = 'not-a-number';
  assert.equal(resolveMetricsPort(3001), 4001);
  delete process.env.METRICS_PORT;
});

test('startMetricsServer: serves metrics on GET /metrics with the given content type', async () => {
  process.env.METRICS_PORT = '0'; // ephemeral port, avoids clashing with a real service
  const log = createLogSpy();
  const metricsBody = '# HELP test_metric\ntest_metric 1\n';
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain; version=0.0.4',
    getMetrics: () => metricsBody,
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics');
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'text/plain; version=0.0.4');
    assert.equal(res.body, metricsBody);
    assert.equal(log.infoCalls.length, 1, 'logs the listening address once');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: non-GET request or path other than /metrics yields HTTP 404 before auth evaluation', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  let getMetricsCalls = 0;
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => {
      getMetricsCalls++;
      return 'ok';
    },
    scrapeToken: 'required-token-abc',
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    // Path other than /metrics
    const resPath = await get(port, '/health');
    assert.equal(resPath.status, 404);
    assert.equal(resPath.body, 'Not Found');

    const resNested = await get(port, '/metrics/sub');
    assert.equal(resNested.status, 404);

    // Non-GET methods on /metrics
    const resPost = await request(port, 'POST', '/metrics');
    assert.equal(resPost.status, 404);

    const resPut = await request(port, 'PUT', '/metrics');
    assert.equal(resPut.status, 404);

    const resDelete = await request(port, 'DELETE', '/metrics');
    assert.equal(resDelete.status, 404);

    assert.equal(getMetricsCalls, 0, 'getMetrics must not be called on 404');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: responds 500 and logs when getMetrics rejects', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => Promise.reject(new Error('boom')),
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics');
    assert.equal(res.status, 500);
    assert.equal(log.errorCalls.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

// ── Auth tests (#528 & #864) ──────────────────────────────────────────────────

test('startMetricsServer: scrapeToken auth branch with valid Bearer token yields HTTP 200 and exact payload', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const metricsBody = '# HELP http_requests_total\nhttp_requests_total 42\n';
  const scrapeToken = 'valid-super-secret-token';
  let getMetricsCalls = 0;

  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain; version=0.0.4',
    getMetrics: () => {
      getMetricsCalls++;
      return metricsBody;
    },
    scrapeToken,
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics', { Authorization: `Bearer ${scrapeToken}` });
    assert.equal(res.status, 200);
    assert.equal(res.contentType, 'text/plain; version=0.0.4');
    assert.equal(res.body, metricsBody);
    assert.equal(getMetricsCalls, 1, 'getMetrics was invoked once for authenticated request');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: scrapeToken set and missing Authorization header yields HTTP 401 without calling getMetrics', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  let getMetricsCalls = 0;

  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => {
      getMetricsCalls++;
      return 'should-not-be-called';
    },
    scrapeToken: 'configured-secret-token',
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics');
    assert.equal(res.status, 401);
    assert.equal(res.body, 'Unauthorized');
    assert.equal(getMetricsCalls, 0, 'spy asserts getMetrics was not called on 401');
    assert.ok(
      res.headers['www-authenticate']?.includes('Bearer realm="metrics"') ||
      res.headers['www-authenticate']?.includes('Bearer realm=metrics'),
      'includes WWW-Authenticate challenge header',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: scrapeToken set and wrong or malformed token yields HTTP 401 with WWW-Authenticate header and no getMetrics call', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  let getMetricsCalls = 0;

  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => {
      getMetricsCalls++;
      return 'should-not-be-called';
    },
    scrapeToken: 'correct-secret-token-123',
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    // Wrong token
    const resWrong = await get(port, '/metrics', { Authorization: 'Bearer wrong-secret-token' });
    assert.equal(resWrong.status, 401);
    assert.equal(resWrong.body, 'Unauthorized');
    assert.ok(
      resWrong.headers['www-authenticate']?.includes('Bearer realm="metrics"') ||
      resWrong.headers['www-authenticate']?.includes('Bearer realm=metrics'),
      'must include WWW-Authenticate challenge on wrong token',
    );

    // Malformed token without Bearer prefix
    const resMalformed = await get(port, '/metrics', { Authorization: 'Basic correct-secret-token-123' });
    assert.equal(resMalformed.status, 401);
    assert.equal(resMalformed.body, 'Unauthorized');
    assert.ok(
      resMalformed.headers['www-authenticate']?.includes('Bearer realm="metrics"') ||
      resMalformed.headers['www-authenticate']?.includes('Bearer realm=metrics'),
    );

    // Invalid format
    const resInvalid = await get(port, '/metrics', { Authorization: 'InvalidFormat' });
    assert.equal(resInvalid.status, 401);

    assert.equal(getMetricsCalls, 0, 'spy asserts getMetrics was never called for any unauthorized request');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: with scrapeToken omitted, unauthenticated GET /metrics yields HTTP 200', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const metricsBody = 'test_metric 2\n';
  let getMetricsCalls = 0;

  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => {
      getMetricsCalls++;
      return metricsBody;
    },
    log,
    // scrapeToken intentionally omitted
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics');
    assert.equal(res.status, 200);
    assert.equal(res.body, metricsBody);
    assert.equal(getMetricsCalls, 1, 'getMetrics called for unauthenticated request');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: logs auth status on startup', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();

  const serverWithAuth = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => 'ok',
    scrapeToken: 'my-token',
    log,
  });

  try {
    await new Promise<void>((resolve) => serverWithAuth.once('listening', resolve));
    const infoCall = log.infoCalls[0];
    assert.ok(infoCall.obj && 'authenticated' in infoCall.obj, 'should log authenticated status');
    assert.equal((infoCall.obj as any).authenticated, true, 'authenticated should be true when token set');
    assert.ok(infoCall.msg?.includes('auth required'), 'log message should mention auth required');
  } finally {
    await new Promise<void>((resolve) => serverWithAuth.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});
