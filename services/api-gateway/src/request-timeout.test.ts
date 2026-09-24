import test from 'tape';
import { buildApp } from './index.js';
import { createMockPrisma } from './test-utils.js';
import { GATEWAY_TIMEOUT_CONFIG } from './timeout-config.js';

test('Fastify uses the documented request and connection timeouts on the gateway app', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });
  t.equal((app.initialConfig as any).requestTimeout, GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs, 'requestTimeout uses centralized config');
  t.equal((app.initialConfig as any).connectionTimeout, GATEWAY_TIMEOUT_CONFIG.connectionTimeoutMs, 'connectionTimeout uses centralized config');
  await app.close();
  t.end();
});

test('gateway routes expose centralized timeout metadata', async (t) => {
  const app = buildApp({ prisma: createMockPrisma() as any, logger: false });

  const routes = [
    '/api/deployments',
    '/api/assets',
    '/api/quote',
  ];

  for (const url of routes) {
    const response = await app.inject({ method: 'GET', url });
    t.equal(response.headers[GATEWAY_TIMEOUT_CONFIG.responseHeader], String(GATEWAY_TIMEOUT_CONFIG.requestTimeoutMs), `${url} exposes the timeout`);
  }

  await app.close();
  t.end();
});
