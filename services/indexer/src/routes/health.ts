import type { FastifyInstance } from 'fastify';
import { buildIndexerHealthResponse } from '@bettapay/validation';

export interface IndexerHealthRouteDependencies {
  queryDatabase: () => Promise<unknown>;
  pingRedis: () => Promise<string>;
  getQueueJobCounts: () => Promise<Record<string, number>>;
  getQueueIsPaused: () => Promise<boolean>;
  getLatestLedger: () => Promise<{ sequence: number }>;
  redisHealthState: { connected: boolean; errors: number; reconnects: number; lastError?: string };
  latestLedgerCursor?: number;
  latestLedgerSequence?: number;
  lagWarnThreshold: number;
  startTime: number;
  service: string;
  version: string;
}

export function registerIndexerHealthRoute(
  fastify: FastifyInstance,
  deps: IndexerHealthRouteDependencies,
): void {
  fastify.get('/api/health', { config: { rateLimit: false } }, async (_request, reply) => {
    const health = await buildIndexerHealthResponse(deps);
    return reply.code(health.status === 'unhealthy' ? 503 : 200).send(health);
  });
}
