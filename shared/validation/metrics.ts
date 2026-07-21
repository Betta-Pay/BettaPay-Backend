/**
 * Shared Prometheus Metrics Module (Issue #255)
 *
 * Provides a consistent way for every service to expose a /metrics endpoint
 * with Prometheus-compatible output. Each service creates its own Registry
 * so metrics are isolated per process.
 *
 * Usage in a service:
 *   import { createMetricsRegistry, registerMetricsEndpoint } from '@bettapay/validation';
 *   const metricsRegistry = createMetricsRegistry();
 *   registerMetricsEndpoint(fastify, metricsRegistry, env.INTER_SERVICE_SECRET);
 */

import { collectDefaultMetrics, Registry } from 'prom-client';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createServiceAuth } from './plugins.js';

/**
 * Creates a new Prometheus Registry pre-configured with default metrics
 * (process CPU, memory, event loop lag, garbage collection, heap stats).
 *
 * Each service should call this once at startup to get its own registry.
 */
export function createMetricsRegistry(options?: {
  prefix?: string;
  labels?: Record<string, string>;
}): Registry {
  const registry = new Registry();
  collectDefaultMetrics({
    register: registry,
    prefix: options?.prefix,
    labels: options?.labels,
  });
  return registry;
}

/**
 * Registers a GET /metrics endpoint on a Fastify instance.
 *
 * The endpoint is protected by `serviceAuth` — callers must present a valid
 * `x-service-token` header matching the shared `INTER_SERVICE_SECRET`.
 *
 * The response is `text/plain` Prometheus exposition format, suitable for
 * scraping by a Prometheus server or compatible collector.
 *
 * @param fastify  - The Fastify instance to register the route on.
 * @param registry - The prom-client Registry whose metrics to expose.
 * @param secret   - The shared INTER_SERVICE_SECRET for serviceAuth.
 */
export function registerMetricsEndpoint(
  fastify: FastifyInstance,
  registry: Registry,
  secret: string,
): void {
  const serviceAuth = createServiceAuth(secret);

  fastify.get('/metrics', {
    preValidation: [serviceAuth],
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const metrics = await registry.metrics();
    return reply
      .header('Content-Type', registry.contentType)
      .send(metrics);
  });
}
