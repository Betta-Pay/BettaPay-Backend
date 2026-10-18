import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerErrorHandler } from "@bettapay/validation";
import {
  createQuoteQuerySchema,
  FX_QUOTE_BODY_LIMIT_DEFAULT,
  isPositiveFiniteAmount,
  POSITIVE_AMOUNT_MESSAGE,
  resolveFxQuoteBodyLimit,
} from "./validation.js";

test("quote query validation applies the production slippage ceiling", () => {
  const production = createQuoteQuerySchema("production");
  const development = createQuoteQuerySchema("development");

  assert.equal(production.safeParse({ slippageBps: "1001" }).success, false);
  assert.equal(development.safeParse({ slippageBps: "1001" }).success, true);
});

test("quote amount validation rejects zero, negative, NaN and Infinity", () => {
  const schema = createQuoteQuerySchema("development");

  for (const amount of ["0", "0.0", "-1", "-0.5", "NaN", "Infinity", "-Infinity", "not-a-number"]) {
    const result = schema.safeParse({ amount });
    assert.equal(result.success, false, `${amount} is rejected`);
    if (!result.success) {
      assert.deepEqual(result.error.errors[0].path, ["amount"], `${amount} names the field`);
      assert.equal(result.error.errors[0].message, POSITIVE_AMOUNT_MESSAGE);
    }
  }
});

test("quote amount validation accepts a positive finite amount", () => {
  const schema = createQuoteQuerySchema("development");

  const parsed = schema.parse({ amount: "250.75" });
  assert.equal(parsed.amount, "250.75");
  assert.equal(isPositiveFiniteAmount("0.0001"), true);
});

test("quote body limit is configurable and falls back safely", () => {
  assert.equal(resolveFxQuoteBodyLimit("65536"), 65_536);
  assert.equal(resolveFxQuoteBodyLimit(32_768), 32_768);
  assert.equal(resolveFxQuoteBodyLimit("not-a-number"), FX_QUOTE_BODY_LIMIT_DEFAULT);
  assert.equal(resolveFxQuoteBodyLimit(undefined), FX_QUOTE_BODY_LIMIT_DEFAULT);
});

test("oversized quote body returns a typed 413 and a normal body is processed", async () => {
  const app = Fastify();
  registerErrorHandler(app);
  app.post(
    "/api/quote/verify",
    { bodyLimit: 128 },
    async () => ({ ok: true }),
  );

  const oversized = await app.inject({
    method: "POST",
    url: "/api/quote/verify",
    payload: { quoteId: "x".repeat(512) },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(JSON.parse(oversized.body).error.code, "PAYLOAD_TOO_LARGE");

  const accepted = await app.inject({
    method: "POST",
    url: "/api/quote/verify",
    payload: { quoteId: "quote_1" },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(accepted.body), { ok: true });

  await app.close();
});
