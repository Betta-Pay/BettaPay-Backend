import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildPaginationMeta } from '@bettapay/shared-types';
import { EventListQuery } from '@bettapay/validation';

export interface IndexerEventsRouteDependencies {
  prisma: {
    indexedEvent: {
      findMany: (args: unknown) => Promise<unknown[]>;
      count: (args: unknown) => Promise<number>;
    };
  };
  serviceAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  getLatestLedgerCursor: () => number | undefined;
}

/** Register the indexer's read-only event inventory endpoint. */
export function registerIndexerEventsRoutes(
  fastify: FastifyInstance,
  deps: IndexerEventsRouteDependencies,
): void {
  fastify.get(
    '/api/events',
    { preValidation: [deps.serviceAuth as never] },
    async (request) => {
      const { limit, page, type, topic, contractId, fromLedger, toLedger } =
        EventListQuery.parse(request.query ?? {});
      const where: Record<string, unknown> = {};
      if (type) where.type = type;
      if (topic) where.topics = { has: topic };
      if (contractId) where.contractId = contractId;
      if (fromLedger !== undefined || toLedger !== undefined) {
        const ledger: Record<string, number> = {};
        if (fromLedger !== undefined) ledger.gte = fromLedger;
        if (toLedger !== undefined) ledger.lte = toLedger;
        where.ledger = ledger;
      }
      const [data, total] = await Promise.all([
        deps.prisma.indexedEvent.findMany({
          where,
          take: limit,
          skip: (page - 1) * limit,
          orderBy: { indexedAt: 'desc' },
        }),
        deps.prisma.indexedEvent.count({ where }),
      ]);
      return {
        data,
        pagination: buildPaginationMeta(page, limit, total),
        latestLedgerCursor: deps.getLatestLedgerCursor(),
      };
    },
  );
}
