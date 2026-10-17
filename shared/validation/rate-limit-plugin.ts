import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export interface SharedRateLimitOptions {
  max?: number;
  timeWindow?: number | string;
  global?: boolean;
  skip?: (request: unknown) => boolean;
  keyGenerator?: (request: unknown) => string;
  errorResponseBuilder?: (request: unknown, context: { max: number; after: string }) => unknown;
  addHeaders?: Record<string, boolean>;
}

/** Register the repository-wide rate-limit defaults in one place. */
export function registerSharedRateLimit(fastify: FastifyInstance, options: SharedRateLimitOptions = {}): void {
  fastify.register(rateLimit, {
    global: options.global ?? true,
    max: options.max ?? 500,
    timeWindow: options.timeWindow ?? '1 minute',
    ...(options.skip ? { skip: options.skip } : {}),
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    ...(options.errorResponseBuilder ? { errorResponseBuilder: options.errorResponseBuilder } : {}),
    addHeaders: options.addHeaders ?? {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  } as any);
}
