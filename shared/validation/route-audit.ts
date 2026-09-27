import type { FastifyInstance } from 'fastify';

const PUBLIC_PATHS = new Set(['/api/health', '/api/health/live', '/api/deployments']);

export function auditRouteAuthPolicy(
  fastify: FastifyInstance,
  opts: { mode?: 'warn' | 'enforce' } = {},
): void {
  const mode = opts.mode ?? 'warn';

  fastify.addHook('onRoute', (route) => {
    const path = typeof route.path === 'string' ? route.path : '';
    const config = route.config as { public?: boolean } | undefined;
    if (PUBLIC_PATHS.has(path) || config?.public === true) return;

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