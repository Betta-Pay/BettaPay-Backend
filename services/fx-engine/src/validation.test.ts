import test from "node:test";
import assert from "node:assert/strict";
import { createQuoteQuerySchema } from "./validation.js";

test("quote query validation applies the production slippage ceiling", () => {
  const production = createQuoteQuerySchema("production");
  const development = createQuoteQuerySchema("development");

  assert.equal(production.safeParse({ slippageBps: "1001" }).success, false);
  assert.equal(development.safeParse({ slippageBps: "1001" }).success, true);
});