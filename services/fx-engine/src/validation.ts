import { z } from "zod";
import { CurrencyCode, envAwareSchema } from "@bettapay/validation";

export const createQuoteQuerySchema = (nodeEnv?: string) =>
  envAwareSchema(nodeEnv, ({ isProduction }) =>
    z.object({
      from: CurrencyCode.default("USDC"),
      to: CurrencyCode.default("NGN"),
      amount: z
        .string()
        .regex(/^\d+(\.\d+)?$/, "amount must be a numeric string")
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