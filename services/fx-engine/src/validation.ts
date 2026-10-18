import { z } from "zod";
import { CurrencyCode, envAwareSchema } from "@bettapay/validation";

/** #911 — default ceiling for a quote-route request body. */
export const FX_QUOTE_BODY_LIMIT_DEFAULT = 1_048_576;

/** Resolve the configured quote body limit, falling back to the safe default. */
export function resolveFxQuoteBodyLimit(raw?: string | number): number {
  const parsed = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : FX_QUOTE_BODY_LIMIT_DEFAULT;
}

/**
 * #912 — an amount the quote engine can actually compute with.
 *
 * Rejects zero, negatives, NaN, Infinity and anything that is not a plain
 * decimal string, before any rate lookup is attempted.
 */
export function isPositiveFiniteAmount(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

export const POSITIVE_AMOUNT_MESSAGE =
  "amount must be a positive finite number";

export const createQuoteQuerySchema = (nodeEnv?: string) =>
  envAwareSchema(nodeEnv, ({ isProduction }) =>
    z.object({
      from: CurrencyCode.default("USDC"),
      to: CurrencyCode.default("NGN"),
      amount: z
        .string()
        .refine(isPositiveFiniteAmount, { message: POSITIVE_AMOUNT_MESSAGE })
        .default("1"),
      slippageBps: z
        .string()
        .regex(/^\d+$/, "slippageBps must be a non-negative integer")
        .refine((value) => parseInt(value, 10) <= (isProduction ? 1000 : 5000), {
          message: isProduction
            ? "slippageBps must be between 0 and 1000"
            : "slippageBps must be between 0 and 5000",
        })
        .optional(),
    }),
  );

export const createHistoryQuerySchema = (nodeEnv?: string) =>
  envAwareSchema(nodeEnv, () =>
    z.object({
      from: CurrencyCode,
      to: CurrencyCode,
      at: z.string().optional(),
    }),
  );

export const createVerifyQuoteBodySchema = (nodeEnv?: string) =>
  envAwareSchema(nodeEnv, () =>
    z.object({
      quoteId: z.string().min(1),
    }),
  );