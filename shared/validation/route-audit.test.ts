import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { auditRouteAuthPolicy } from './route-audit.js';

function createLoggerSpy() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      level: 'warn',
      stream: {
        write(chunk: string) {
          warnings.push(chunk);
        },
      },
    },
  };
}

test('auditRouteAuthPolicy warns once for an unprotected non-health route', async () => {
  const { warnings, logger } = createLoggerSpy();
  const app = Fastify({ logger });
  auditRouteAuthPolicy(app);
  app.post('/api/payments', async () => ({ ok: true }));

  const routeWarnings = warnings.filter((warning) => warning.includes('[route-auth]'));
  assert.equal(routeWarnings.length, 1);
  assert.match(routeWarnings[0], /\[route-auth\] POST \/api\/payments has no preValidation hook/);
  await app.close();
});

test('auditRouteAuthPolicy does not warn for a protected route', async () => {
  const { warnings, logger } = createLoggerSpy();
  const app = Fastify({ logger });
  auditRouteAuthPolicy(app);
  app.post('/api/payments', { preValidation: async () => {} }, async () => ({ ok: true }));

  assert.equal(warnings.filter((warning) => warning.includes('[route-auth]')).length, 0);
  await app.close();
});