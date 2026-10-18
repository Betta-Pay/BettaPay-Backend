import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { auditRouteAuthPolicy, PUBLIC_PATHS } from './route-audit.js';

test('PUBLIC_PATHS is exactly the documented public route allowlist', () => {
  assert.deepEqual([...PUBLIC_PATHS], ['/api/health', '/api/health/live', '/api/deployments']);
});

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

test('auditRouteAuthPolicy allows documented public paths in warn mode', async () => {
  const { warnings, logger } = createLoggerSpy();
  const app = Fastify({ logger });
  auditRouteAuthPolicy(app);
  for (const path of PUBLIC_PATHS) app.get(path, async () => ({ ok: true }));

  assert.equal(warnings.filter((warning) => warning.includes('[route-auth]')).length, 0);
  await app.close();
});

test('auditRouteAuthPolicy enforces unprotected routes and accepts public config', async () => {
  const app = Fastify();
  auditRouteAuthPolicy(app, { mode: 'enforce' });

  assert.throws(
    () => app.get('/api/private', async () => ({ ok: true })),
    /GET \/api\/private has no preValidation hook/,
  );
  assert.doesNotThrow(() =>
    app.get('/api/explicit-public', { config: { public: true } }, async () => ({ ok: true })),
  );
  assert.doesNotThrow(() =>
    app.get('/api/function-guarded', { preValidation: async () => {} }, async () => ({ ok: true })),
  );
  await app.close();
});