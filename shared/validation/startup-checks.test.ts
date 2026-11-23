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

test("runStartupChecks leaves behavior unchanged in development when DATABASE_READ_REPLICA_URL is unset", async () => {
  const report = await runStartupChecks({
    service: "test-service",
    version: "test",
    logger: logger(),
    env: { NODE_ENV: "development" },
    checks: [{ name: "prisma", fn: async () => {}, critical: true }],
  });

  assert.equal(report.overallStatus, "healthy");
  const replicaCheck = report.checks.find((c) => c.name === "read-replica");
  assert.ok(replicaCheck);
  assert.equal(replicaCheck.status, "ok");
  assert.equal(replicaCheck.error, undefined);
});

test("runStartupChecks emits explicit warning in production when DATABASE_READ_REPLICA_URL is unset", async () => {
  let warned = false;
  const mockLogger = {
    fatal() {},
    warn() { warned = true; },
    info() {},
  } as never;

  const report = await runStartupChecks({
    service: "test-service",
    version: "test",
    logger: mockLogger,
    env: { NODE_ENV: "production" },
    checks: [{ name: "prisma", fn: async () => {}, critical: true }],
  });

  assert.equal(report.overallStatus, "healthy"); // degraded non-critical check
  const replicaCheck = report.checks.find((c) => c.name === "read-replica");
  assert.ok(replicaCheck);
  assert.equal(replicaCheck.status, "ok");
  assert.ok(replicaCheck.error?.includes("DATABASE_READ_REPLICA_URL"));
  assert.equal(warned, true);
});

test("runStartupChecks triggers fail-fast in production when DATABASE_READ_REPLICA_URL is unset and failFast is enabled", async () => {
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
      env: { NODE_ENV: "production" },
      readReplicaFailFast: true,
      checks: [{ name: "prisma", fn: async () => {}, critical: true }],
    });

    assert.equal(report.overallStatus, "unhealthy");
    const replicaCheck = report.checks.find((c) => c.name === "read-replica");
    assert.ok(replicaCheck);
    assert.equal(replicaCheck.status, "fail");
    assert.equal(exitCode, 1);
  } finally {
    process.exit = originalExit;
  }
});

test("runStartupChecks passes in production when DATABASE_READ_REPLICA_URL is set", async () => {
  const report = await runStartupChecks({
    service: "test-service",
    version: "test",
    logger: logger(),
    env: { NODE_ENV: "production", DATABASE_READ_REPLICA_URL: "postgres://replica:5432/db" },
    readReplicaFailFast: true,
    checks: [{ name: "prisma", fn: async () => {}, critical: true }],
  });

  assert.equal(report.overallStatus, "healthy");
  const replicaCheck = report.checks.find((c) => c.name === "read-replica");
  assert.ok(replicaCheck);
  assert.equal(replicaCheck.status, "ok");
  assert.equal(replicaCheck.error, undefined);
});
// #1080 — fatal startup errors must flush buffered logs before exiting.
test("runStartupChecks flushes the logger before process.exit(1)", async () => {
  const originalExit = process.exit;
  const events: string[] = [];
  process.exit = ((code?: number) => {
    events.push(`exit:${code}`);
  }) as typeof process.exit;

  const flushingLogger = {
    fatal() {},
    warn() {},
    info() {},
    flush(cb?: (err?: Error) => void) {
      setImmediate(() => {
        events.push("flushed");
        cb?.();
      });
    },
  } as never;

  try {
    await runStartupChecks({
      service: "test-service",
      version: "test",
      logger: flushingLogger,
      checks: [{ name: "dependency", fn: async () => { throw new Error("down"); }, critical: true }],
    });
    assert.deepEqual(events, ["flushed", "exit:1"]);
  } finally {
    process.exit = originalExit;
  }
});

test("runStartupChecks does not hang when logger flush never completes", async () => {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
  }) as typeof process.exit;

  const stuckLogger = { fatal() {}, warn() {}, info() {}, flush() {} } as never;

  try {
    const started = Date.now();
    await runStartupChecks({
      service: "test-service",
      version: "test",
      logger: stuckLogger,
      checks: [{ name: "dependency", fn: async () => { throw new Error("down"); }, critical: true }],
    });
    assert.equal(exitCode, 1);
    assert.ok(Date.now() - started < 2000, "flush timeout bounds the exit delay");
  } finally {
    process.exit = originalExit;
  }
});
