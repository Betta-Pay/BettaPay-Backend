import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createErrorResponse, ErrorCodes } from "@bettapay/validation";
import { createVerifyQuoteBodySchema } from "./validation.js";

export interface StoredQuote {
  quoteId: string;
  from: string;
  to: string;
  amount: string;
  result: string;
  rate: string;
  slippageBps: number;
  expiresAt: number; // Unix ms — quote validity cutoff
  rateBatchId: string;
  unroundedRate?: number;
}

export interface VerifyQuoteRouteBody {
  quoteId?: unknown;
}

export interface VerifyQuoteDeps {
  nodeEnv?: string;
  redis: { get(key: string): Promise<string | null> };
  log: { error(obj: unknown, msg: string): void };
  quoteKeyPrefix: string;
  quoteTtlMs: number;
  quoteMinAgeMs: number;
  quoteMaxLifetimeMs: number;
  defaultSlippageBps: number;
  getCurrentRate: (from: string, to: string) => number;
  isFallbackActive: () => boolean;
  getFallbackBatchId: (currency: string) => string;
  now?: () => number;
}

export function createVerifyQuoteHandler(deps: VerifyQuoteDeps) {
  const VerifyQuoteBody = createVerifyQuoteBodySchema(deps.nodeEnv);

  return async (
    request: FastifyRequest<{ Body: VerifyQuoteRouteBody }>,
    reply: FastifyReply,
  ) => {
    let body: z.infer<typeof VerifyQuoteBody>;
    try {
      body = VerifyQuoteBody.parse(request.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply
          .code(400)
          .send(
            createErrorResponse(
              ErrorCodes.VALIDATION_ERROR,
              "Invalid request body",
              err.errors,
            ),
          );
      }
      throw err;
    }

    let raw: string | null;
    try {
      raw = await deps.redis.get(`${deps.quoteKeyPrefix}${body.quoteId}`);
    } catch (err) {
      deps.log.error(
        { err, quoteId: body.quoteId },
        "Failed to retrieve quote from Redis",
      );
      return reply
        .code(503)
        .send(
          createErrorResponse(
            ErrorCodes.INTERNAL_ERROR,
            "Quote verification temporarily unavailable",
          ),
        );
    }

    if (!raw) {
      return reply
        .code(404)
        .send(createErrorResponse(ErrorCodes.NOT_FOUND, "Quote not found"));
    }

    let stored: StoredQuote;
    try {
      stored = JSON.parse(raw) as StoredQuote;
    } catch (err) {
      deps.log.error(
        { err, quoteId: body.quoteId },
        "Failed to parse stored quote JSON",
      );
      return reply
        .code(500)
        .send(
          createErrorResponse(
            ErrorCodes.INTERNAL_ERROR,
            "Stored quote data is corrupted",
          ),
        );
    }

    const now = deps.now ? deps.now() : Date.now();

    // Quote age validation
    const createdAt = stored.expiresAt - deps.quoteTtlMs;
    const quoteAge = now - createdAt;
    if (quoteAge < deps.quoteMinAgeMs) {
      return reply
        .code(400)
        .send(createErrorResponse(ErrorCodes.QUOTE_TOO_YOUNG, "Quote too young"));
    }
    if (quoteAge > deps.quoteMaxLifetimeMs) {
      return reply
        .code(400)
        .send(createErrorResponse(ErrorCodes.QUOTE_TOO_OLD, "Quote too old"));
    }

    const currentRate = deps.getCurrentRate(stored.from, stored.to);
    const slippageBps = stored.slippageBps ?? deps.defaultSlippageBps;
    // Use the quote's stored rateBatchId so background rate refreshes do not
    // overwrite or invalidate the verified quote's batch reference (#1051).
    const rateBatchId =
      stored.rateBatchId ?? deps.getFallbackBatchId(stored.from);
    const quotedRate = stored.unroundedRate ?? parseFloat(stored.rate);
    const fallbackAccepted = deps.isFallbackActive();

    // Fail-open: if market rate is unavailable (fallback mode), accept by expiry
    let valid: boolean;
    if (fallbackAccepted) {
      valid = now <= stored.expiresAt;
    } else {
      const deviation =
        (Math.abs(currentRate - quotedRate) / quotedRate) * 10000;
      valid = now <= stored.expiresAt && deviation <= slippageBps;
    }

    return {
      valid,
      stale: !valid,
      quoteId: stored.quoteId,
      fallbackAccepted,
      from: stored.from,
      to: stored.to,
      rate: stored.rate,
      currentRate: currentRate.toFixed(8),
      slippageBps,
      slippageLimit: (slippageBps / 10_000).toFixed(4),
      expiresAt: new Date(stored.expiresAt).toISOString(),
      rateBatchId,
    };
  };
}
