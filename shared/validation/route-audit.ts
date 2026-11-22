import type { FastifyInstance } from 'fastify';

/**
 * Every route that is intentionally reachable without a preValidation auth
 * hook, across api-gateway and the downstream services (#1084). Keep this in
 * sync when adding a public route; anything missing here is reported by
 * auditRouteAuthPolicy as unprotected. Routes may alternatively opt out with
 * `config: { public: true }`.
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  // Health / liveness probes (all services)
  '/api/health',
  '/api/health/live',
  '/api/health/all',
  // OpenAPI document (api-gateway)
  '/api/docs/json',
  // Login flows — the caller has no token yet (api-gateway). /api/auth/refresh
  // verifies the JWT inside its handler, not via preValidation.
  '/api/auth/challenge',
  '/api/auth/verify',
  '/api/auth/google',
  '/api/auth/wallet/verify',
  '/api/auth/refresh',
  // Public reference and pricing data (api-gateway + fx-engine)
  '/api/rates',
  '/api/rates/history',
  '/api/currencies',
  '/api/assets',
  '/api/quote',
  '/api/quote/verify',
  // Contract deployment manifest (api-gateway)
  '/api/deployments',
]);

export function auditRouteAuthPolicy(
  fastify: FastifyInstance,
  opts: { mode?: 'warn' | 'enforce' } = {},
): void {
  const mode = opts.mode ?? 'warn';

  fastify.addHook('onRoute', (route) => {
    const path = typeof route.path === 'string' ? route.path : '';
    const config = route.config as { public?: boolean } | undefined;
    if (PUBLIC_PATHS.has(path) || config?.public === true) return;
    // CORS preflight (e.g. @fastify/cors's `OPTIONS *`) never carries
    // credentials, so it cannot sit behind an auth hook.
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.every((m) => m === 'OPTIONS')) return;

    const preValidation = route.preValidation;
    const hasPreValidation = Array.isArray(preValidation)
      ? preValidation.length > 0
      : typeof preValidation === 'function';
    if (hasPreValidation) return;

    const msg = `[route-auth] ${route.method} ${path} has no preValidation hook`;
    if (mode === 'enforce') {
      throw new Error(`${msg} — add fastify.serviceAuth or mark config.public.`);
    }
    fastify.log.warn(msg);
  });
}