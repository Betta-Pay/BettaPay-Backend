import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveMetricsPort, startMetricsServer } from './metrics-server.js';

function get(port: number, path: string, headers?: Record<string, string>): Promise<{ status: number; contentType?: string; body: string }> {
  return new Promise((resolve, reject) => {
    // agent: false + Connection: close avoids a keep-alive socket lingering
    // past this request — each test binds its own ephemeral (port 0) server,
    // and the OS can reissue that port number for the next test's server.
    const req = http.request(
      { 
        host: '127.0.0.1', 
        port, 
        path, 
        method: 'GET', 
        agent: false, 
        headers: { Connection: 'close', ...headers } 
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, contentType: res.headers['content-type'], body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
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

test('startMetricsServer: returns 404 for any path other than /metrics', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => 'ok',
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/health');
    assert.equal(res.status, 404);
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

// ── Auth tests (#528) ─────────────────────────────────────────────────────────

test('startMetricsServer: rejects unauthorized scrape when scrapeToken is set', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => 'test_metric 1',
    scrapeToken: 'secret-token-12345',
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    // Request without Authorization header
    const res1 = await get(port, '/metrics');
    assert.equal(res1.status, 401, 'should reject request without auth header');
    assert.equal(res1.body, 'Unauthorized');

    // Request with wrong token
    const res2 = await get(port, '/metrics', { Authorization: 'Bearer wrong-token' });
    assert.equal(res2.status, 401, 'should reject request with wrong token');
    assert.equal(res2.body, 'Unauthorized');

    // Request with malformed auth header
    const res3 = await get(port, '/metrics', { Authorization: 'InvalidFormat' });
    assert.equal(res3.status, 401, 'should reject request with malformed auth header');
    assert.equal(res3.body, 'Unauthorized');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: serves metrics when correct scrapeToken is provided', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const metricsBody = '# HELP test_metric\ntest_metric 1\n';
  const scrapeToken = 'correct-secret-token';
  
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain; version=0.0.4',
    getMetrics: () => metricsBody,
    scrapeToken,
    log,
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    const res = await get(port, '/metrics', { Authorization: `Bearer ${scrapeToken}` });
    assert.equal(res.status, 200, 'should serve metrics with valid token');
    assert.equal(res.contentType, 'text/plain; version=0.0.4');
    assert.equal(res.body, metricsBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.METRICS_PORT;
  }
});

test('startMetricsServer: serves metrics unauthenticated when scrapeToken is omitted', async () => {
  process.env.METRICS_PORT = '0';
  const log = createLogSpy();
  const metricsBody = 'test_metric 2';
  
  const server = startMetricsServer({
    appPort: 3000,
    contentType: 'text/plain',
    getMetrics: () => metricsBody,
    log,
    // No scrapeToken provided
  });

  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;

    // Request without auth should succeed when no token is configured
    const res = await get(port, '/metrics');
    assert.equal(res.status, 200, 'should serve metrics without auth when token not configured');
    assert.equal(res.body, metricsBody);
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
