import assert from "node:assert/strict";
import test from "node:test";
import { runStartupChecks } from "./startup-checks.js";

function logger() {
  return { fatal() {}, warn() {}, info() {} } as never;
}

test("runStartupChecks reports healthy checks", async () => {
  const report = await runStartupChecks({
    service: "test-service",
    version: "test",
    logger: logger(),
    checks: [{ name: "dependency", fn: async () => {}, critical: true }],
  });

  assert.equal(report.overallStatus, "healthy");
  assert.equal(report.checks[0].status, "ok");
});

test("runStartupChecks fails the process for a critical check", async () => {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
  }) as typeof process.exit;

  try {
    const report = await runStartupChecks({
      service: "test-service",
      version: "test",
      logger: logger(),
      checks: [{
        name: "dependency",
        fn: async () => { throw new Error("connection refused"); },
        critical: true,
      }],
    });

    assert.equal(report.overallStatus, "unhealthy");
    assert.equal(report.checks[0].status, "fail");
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});