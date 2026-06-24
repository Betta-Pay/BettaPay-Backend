/**
 * Settlement Engine — BettaPay Backend
 *
 * Handles settlement processing with fee deduction and audit trail.
 *
 * Endpoints:
 *   GET  /api/health              — liveness and Redis connectivity probe
 *   GET  /api/settlements         — list all settlements
 *   POST /api/settlements         — create and process a settlement
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'crypto';
import {
  validateEnv,
  CreateSettlementBody,
  Settlement,
} from "@bettapay/validation";
import { Queue, Worker } from 'bullmq';

interface CreateSettlementRouteBody {
  merchantId?: unknown;
  amount?: unknown;
  asset?: unknown;
}

const env = validateEnv(process.env);
const PORT = Number(process.env.PORT ?? '3001');
const startTime = Date.now();

const fastify = Fastify({ 
  logger: true,
  genReqId: function (req) {
    return (req.headers['x-request-id'] as string) || crypto.randomUUID();
  }
});

fastify.register(cors, { 
  origin: env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) 
});

// Global rate limit: 1000 requests per minute
await fastify.register(rateLimit, {
  global: true,
  max: 1000,
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Retry after ${context.after}.`,
  }),
});

const redisConnection = new URL(env.REDIS_URL);
const connectionParams = {
  host: redisConnection.hostname,
  port: parseInt(redisConnection.port || '6379', 10),
};

const settlementQueue = new Queue('settlements', { connection: connectionParams });

const worker = new Worker('settlements', async job => {
  console.log(`[Settlement Worker] Processing job ${job.id}`);
  // In a real app, this interacts with Soroban
}, { connection: connectionParams });

// In-memory store for development (Gateway uses DB, this worker processes memory queue)
const settlements: Settlement[] = [];

// Mock function to simulate fetching per-merchant fee rules from governance contract / API gateway
async function fetchMerchantFeeBps(merchantId: string): Promise<number> {
  // Real implementation would fetch this from Soroban via indexer or gateway DB
  return 100; // default 100 bps
}

fastify.get('/api/health', async (_request, reply) => {
  let redisConnected = false;

  try {
    await settlementQueue.getJobCounts();
    redisConnected = true;
  } catch (error) {
    fastify.log.warn({ error }, 'Settlement Redis health check failed');
  }

  return reply.code(200).send({
    status: redisConnected ? 'ok' : 'degraded',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    redis: {
      connected: redisConnected,
    },
  });
});

fastify.get('/api/settlements', async (request, reply) => {
  return { settlements, total: settlements.length };
});

fastify.post<{ Body: CreateSettlementRouteBody }>(
  '/api/settlements',
  {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  },
  async (request, reply) => {
  try {
    const d = CreateSettlementBody.parse(request.body);
    const gross = parseFloat(d.amount ?? '0');
    if (gross <= 0) return reply.code(400).send({ error: 'amount must be > 0' });

    // Fetch dynamic fee rules
    const feeBps = await fetchMerchantFeeBps(d.merchantId);
    
    const fee = (gross * feeBps) / 10_000;
    const net = gross - fee;
    const initiatedAt = new Date().toISOString();

    const record: Settlement = {
      id: "set_" + crypto.randomUUID().replace(/-/g, ""),
      merchantId: d.merchantId,
      totalAmount: d.amount,
      asset: d.asset,
      initiatedAt,
      completedAt: initiatedAt,
      status: "completed",
      metadata: {
        grossAmount: gross.toFixed(2),
        feeAmount: fee.toFixed(2),
        netAmount: net.toFixed(2),
        feeBps,
        contractRef: env.SETTLEMENT_CONTRACT_ID,
      },
    };

    settlements.unshift(record);
    await settlementQueue.add('process-settlement', record);

    return reply.code(201).send(record);
  } catch (error) {
    return reply.code(400).send({ error: 'Invalid request payload' });
  }
  },
);

const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
