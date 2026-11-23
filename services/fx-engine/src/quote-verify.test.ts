/**
 * Issue #1051 — Fix error handling, UUID check, error code, and batchIds in POST /api/quote/verify.
 */

import test from "tape";
import Fastify from "fastify";
import { createVerifyQuoteHandler, type StoredQuote, type VerifyQuoteRouteBody } from "./quote-verify.js";

const VALID_UUID = "11111111-2222-4333-8444-555555555555";
const QUOTE_TTL_MS = 60_000;

function createTestApp(overrides: {
  redisGet?: (key: string) => Promise<string | null>;
  getFallbackBatchId?: (currency: string) => string;
  now?: number;
} = {}) {
  const logs: { obj: unknown; msg: string }[] = [];
  const fixedNow = overrides.now ?? 1_700_000_010_000;

  const app = Fastify({ logger: false });
  app.post<{ Body: VerifyQuoteRouteBody }>(
    "/api/quote/verify",
    createVerifyQuoteHandler({
      nodeEnv: "test",
      redis: {
        get: overrides.redisGet ?? (async () => null),
      },
      log: {
        error(obj: unknown, msg: string) {
          logs.push({ obj, msg });
        },
      },
      quoteKeyPrefix: "fx:quote:",
      quoteTtlMs: QUOTE_TTL_MS,
      quoteMinAgeMs: 1_000,
      quoteMaxLifetimeMs: 300_000,
      defaultSlippageBps: 50,
      getCurrentRate: () => 1500,
      isFallbackActive: () => false,
      getFallbackBatchId: overrides.getFallbackBatchId ?? (() => "live-batch-after-refresh"),
      now: () => fixedNow,
    }),
  );

  return { app, logs, fixedNow };
}

test("#1051: invalid quoteId (non-UUID) returns 400 with VALIDATION_ERROR", async (t) => {
  const { app } = createTestApp();

  for (const quoteId of ["not-a-uuid", "", 123, undefined]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/quote/verify",
      payload: quoteId === undefined ? {} : { quoteId },
    });

    t.equal(res.statusCode, 400, `quoteId=${String(quoteId)} returns HTTP 400`);
    const body = JSON.parse(res.body);
    t.equal(
      body.error?.code,
      "VALIDATION_ERROR",
      `quoteId=${String(quoteId)} returns VALIDATION_ERROR instead of INVALID_QUERY`,
    );
  }

  await app.close();
  t.end();
});

test("#1051: Redis get failure is caught, logged cleanly, and returns 503", async (t) => {
  const { app, logs } = createTestApp({
    redisGet: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/quote/verify",
    payload: { quoteId: VALID_UUID },
  });

  t.equal(res.statusCode, 503, "returns HTTP 503 on Redis failure");
  const body = JSON.parse(res.body);
  t.equal(body.error?.code, "INTERNAL_ERROR", "returns structured error envelope");
  t.equal(logs.length, 1, "logs the Redis error once");
  t.ok(logs[0].msg.includes("Redis"), "log message identifies Redis failure");

  await app.close();
  t.end();
});

test("#1051: malformed JSON in Redis is caught, logged cleanly, and returns 500", async (t) => {
  const { app, logs } = createTestApp({
    redisGet: async () => "{corrupted-json",
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/quote/verify",
    payload: { quoteId: VALID_UUID },
  });

  t.equal(res.statusCode, 500, "returns HTTP 500 on corrupted stored JSON");
  const body = JSON.parse(res.body);
  t.equal(body.error?.code, "INTERNAL_ERROR", "returns structured error envelope");
  t.equal(logs.length, 1, "logs the JSON parse error once");
  t.ok(logs[0].msg.includes("parse"), "log message identifies JSON parse failure");

  await app.close();
  t.end();
});

test("#1051: valid quote verifies against stored rateBatchId after background rate refresh", async (t) => {
  const fixedNow = 1_700_000_010_000;
  const storedQuote: StoredQuote = {
    quoteId: VALID_UUID,
    from: "USDC",
    to: "NGN",
    amount: "100",
    result: "150000.00",
    rate: "1500.00000000",
    slippageBps: 50,
    expiresAt: fixedNow + 50_000, // created 10s ago (>= 1s min age, <= 300s max age)
    rateBatchId: "stored-batch-1",
    unroundedRate: 1500,
  };

  const { app } = createTestApp({
    now: fixedNow,
    redisGet: async () => JSON.stringify(storedQuote),
    getFallbackBatchId: () => "live-batch-2",
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/quote/verify",
    payload: { quoteId: VALID_UUID },
  });

  t.equal(res.statusCode, 200, "returns HTTP 200");
  const body = JSON.parse(res.body);
  t.equal(body.valid, true, "quote remains valid after background rate refresh");
  t.equal(body.stale, false, "quote is not stale");
  t.equal(
    body.rateBatchId,
    "stored-batch-1",
    "rateBatchId uses stored quote batchId instead of live cache.batchIds",
  );

  await app.close();
  t.end();
});
