/**
 * Issue #889 — HTTP request duration histogram for the gateway.
 *
 * Every HTTP response must be observed in the http_request_duration_seconds
 * histogram with labels method, route, and status_code so latency percentiles
 * are available in Prometheus.
 */
import test from 'tape';
import * as promClient from 'prom-client';
import { buildApp } from './index.js';
import { createMockPrisma, generateTestJwt } from './test-utils.js';

async function withApp(fn: (app: ReturnType<typeof buildApp>, token: string) => Promise<void>) {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  await app.ready();
  const token = generateTestJwt(app, { merchantId: 'merch-dur-test', ownerId: 'u-dur' });
  try {
    await fn(app, token);
  } finally {
    await app.close();
  }
}

function getHistogramSamples(metricName: string, metrics: string): string[] {
  return metrics
    .split('\n')
    .filter((line) => line.startsWith(metricName) && !line.startsWith('#'));
}

test('#889: http_request_duration_seconds histogram is registered in the Prometheus registry', async (t) => {
  await withApp(async (app, token) => {
    await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
    });

    const metrics = await promClient.register.metrics();
    t.ok(
      metrics.includes('http_request_duration_seconds'),
      'http_request_duration_seconds metric is present in registry output',
    );
  });
  t.end();
});

test('#889: histogram records an observation after a request completes', async (t) => {
  await withApp(async (app, token) => {
    await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
    });

    const metrics = await promClient.register.metrics();
    const samples = getHistogramSamples('http_request_duration_seconds_count', metrics);
    t.ok(samples.length > 0, 'at least one _count sample is present after a request');
    const totalCount = samples.reduce((sum, line) => {
      const val = parseFloat(line.split(' ').at(-1) ?? '0');
      return sum + (isNaN(val) ? 0 : val);
    }, 0);
    t.ok(totalCount >= 1, 'total count is at least 1');
  });
  t.end();
});

test('#889: histogram labels include method, route, and status_code', async (t) => {
  await withApp(async (app, token) => {
    await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { authorization: `Bearer ${token}` },
    });

    const metrics = await promClient.register.metrics();
    t.ok(
      metrics.includes('method="GET"'),
      'method label is present in histogram output',
    );
    t.ok(
      metrics.includes('status_code='),
      'status_code label is present in histogram output',
    );
    t.ok(
      metrics.includes('route='),
      'route label is present in histogram output',
    );
  });
  t.end();
});
