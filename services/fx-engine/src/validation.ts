import { z } from "zod";
import { CurrencyCode, envAwareSchema } from "@bettapay/validation";

/** #911 — default ceiling for a quote-route request body. */
export const FX_QUOTE_BODY_LIMIT_DEFAULT = 1_048_576;

/** #1043 — smallest body limit that still parses a valid quote request. */
export const FX_QUOTE_BODY_LIMIT_MIN = 1024;

/**
 * Resolve the configured quote body limit, falling back to the safe default.
 *
 * #1043 — only a whole number of at least 1KB is honoured. Fractional values
 * ("1024.5", 2048.5), anything below 1024 (including 0 and negatives), and
 * non-numeric input such as "64kb" or "1e3" fall back to the default instead of
 * being truncated into a limit that breaks body parsing.
 */
export function resolveFxQuoteBodyLimit(raw?: string | number): number {
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else {
    const text = String(raw ?? "").trim();
    parsed = /^\d+$/.test(text) ? Number(text) : NaN;
  }
  return Number.isSafeInteger(parsed) && parsed >= FX_QUOTE_BODY_LIMIT_MIN
    ? parsed
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