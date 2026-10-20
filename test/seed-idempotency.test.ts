/**
 * Prisma Seed Script Idempotency Tests (#859)
 *
 * Verifies that running prisma/seed.ts repeatedly:
 *   1. Exits zero on repeated runs.
 *   2. Keeps identical row counts before and after the second run.
 *   3. Upserts the admin merchant instead of creating duplicates (exists exactly once).
 *   4. Keeps key configuration tables stable.
 *   5. Properly cleans up database state between test runs.
 *
 * Runs against DATABASE_URL in CI; skipped locally when PostgreSQL is unreachable.
 */
import test from 'tape';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import pgPkg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pg = (pgPkg as any).default || pgPkg;

const execFileAsync = promisify(execFile);
const SEED_SCRIPT_PATH = fileURLToPath(new URL('../prisma/seed.ts', import.meta.url));

const TEST_ADMIN_ADDRESS = 'GA_IDEMPOTENCY_TEST_ADMIN_859';
const TEST_ADMIN_SECRET = 'idempotency-test-admin-secret-859';

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function createTestPrismaClient() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', () => {});
  const adapter = new PrismaPg(pool);
  return { prisma: new PrismaClient({ adapter }), pool };
}

async function runSeedProcess(envOverrides: Record<string, string> = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--loader', 'ts-node/esm', SEED_SCRIPT_PATH],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL,
          ADMIN_ADDRESS: TEST_ADMIN_ADDRESS,
          ADMIN_SECRET: TEST_ADMIN_SECRET,
          TS_NODE_TRANSPILE_ONLY: 'true',
          ...envOverrides,
        },
        timeout: 30_000,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

test('Prisma seed script: exits non-zero when required env vars are missing (#859)', async (t) => {
  const missingEnvResult = await runSeedProcess({
    ADMIN_ADDRESS: '',
    ADMIN_SECRET: '',
  });

  t.notEqual(
    missingEnvResult.exitCode,
    0,
    'seed script must exit non-zero when ADMIN_ADDRESS or ADMIN_SECRET is missing',
  );
  t.match(
    missingEnvResult.stderr,
    /ADMIN_ADDRESS and ADMIN_SECRET must be set/,
    'outputs descriptive error message when env is missing',
  );
  t.end();
});

test('Prisma seed script: idempotency and row count stability against test database (#859)', async (t) => {
  if (!process.env.DATABASE_URL) {
    if (process.env.CI) {
      t.fail('DATABASE_URL must be configured in CI');
    } else {
      t.skip('Skipping live DB assertions: DATABASE_URL not set');
    }
    t.end();
    return;
  }

  let prisma: PrismaClient | null = null;
  let pool: pg.Pool | null = null;

  try {
    const client = createTestPrismaClient();
    prisma = client.prisma;
    pool = client.pool;

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      const message = `PostgreSQL unreachable at ${process.env.DATABASE_URL}: ${(error as Error).message}`;
      if (process.env.CI) {
        t.fail(message);
      } else {
        t.skip(`Skipping live DB assertions: ${message}`);
      }
      return;
    }

    // Reset test database: clean any prior test merchant
    await prisma.merchant.deleteMany({
      where: {
        OR: [
          { id: TEST_ADMIN_ADDRESS },
          { ownerId: 'admin-user-001' },
        ],
      },
    });

    // Record initial baseline counts
    const initialMerchantCount = await prisma.merchant.count();
    const initialPaymentCount = await prisma.payment.count();
    const initialSettlementCount = await prisma.settlement.count();
    const initialSupportedAssetCount = await prisma.supportedAsset.count();
    const initialWebhookSubCount = await prisma.webhookSubscription.count();

    // ── Run 1 ─────────────────────────────────────────────────────────────
    const run1 = await runSeedProcess();
    t.equal(run1.exitCode, 0, 'seed script exits zero on first run');
    t.match(run1.stdout, /Admin merchant seeded successfully/, 'run 1 outputs success message');

    const adminCountAfterRun1 = await prisma.merchant.count({
      where: { id: TEST_ADMIN_ADDRESS },
    });
    t.equal(adminCountAfterRun1, 1, 'admin merchant exists exactly once after first run');

    const merchantCountAfterRun1 = await prisma.merchant.count();
    t.equal(
      merchantCountAfterRun1,
      initialMerchantCount + 1,
      'merchant table row count incremented by 1 for admin merchant',
    );

    const adminRecordRun1 = await prisma.merchant.findUnique({
      where: { id: TEST_ADMIN_ADDRESS },
    });
    t.ok(adminRecordRun1, 'admin merchant row is present after run 1');
    t.equal(adminRecordRun1?.name, 'BettaPay Merchant LLC');
    t.equal(adminRecordRun1?.ownerId, 'admin-user-001');
    t.equal(adminRecordRun1?.secretHash, hashSecret(TEST_ADMIN_SECRET));

    // ── Run 2 (Repeated execution to assert idempotency) ────────────────────
    const run2 = await runSeedProcess();
    t.equal(run2.exitCode, 0, 'seed script exits zero on repeated run (run 2)');
    t.match(run2.stdout, /Admin merchant seeded successfully/, 'run 2 outputs success message');

    // Acceptance Criterion: The admin merchant exists exactly once after two runs (no duplicate admin)
    const adminCountAfterRun2 = await prisma.merchant.count({
      where: { id: TEST_ADMIN_ADDRESS },
    });
    t.equal(
      adminCountAfterRun2,
      1,
      'admin merchant exists exactly once after two runs (no duplicate admin rows created)',
    );

    // Acceptance Criterion: Running the seed twice yields identical row counts
    const merchantCountAfterRun2 = await prisma.merchant.count();
    t.equal(
      merchantCountAfterRun2,
      merchantCountAfterRun1,
      'merchant row count before and after second run match identically',
    );

    // Acceptance Criterion: Key configuration tables keep stable counts
    const paymentCountAfterRun2 = await prisma.payment.count();
    t.equal(
      paymentCountAfterRun2,
      initialPaymentCount,
      'payment count remains identical after repeated seed runs',
    );

    const settlementCountAfterRun2 = await prisma.settlement.count();
    t.equal(
      settlementCountAfterRun2,
      initialSettlementCount,
      'settlement count remains identical after repeated seed runs',
    );

    const supportedAssetCountAfterRun2 = await prisma.supportedAsset.count();
    t.equal(
      supportedAssetCountAfterRun2,
      initialSupportedAssetCount,
      'supportedAsset count remains identical after repeated seed runs',
    );

    const webhookSubCountAfterRun2 = await prisma.webhookSubscription.count();
    t.equal(
      webhookSubCountAfterRun2,
      initialWebhookSubCount,
      'webhookSubscription count remains identical after repeated seed runs',
    );

    // Assert row content is preserved
    const adminRecordRun2 = await prisma.merchant.findUnique({
      where: { id: TEST_ADMIN_ADDRESS },
    });
    t.equal(adminRecordRun2?.id, adminRecordRun1?.id, 'admin ID preserved across runs');
    t.equal(adminRecordRun2?.ownerId, adminRecordRun1?.ownerId, 'ownerId preserved across runs');
    t.equal(adminRecordRun2?.secretHash, adminRecordRun1?.secretHash, 'secretHash preserved across runs');

    // ── Run 3 (Upsert assertion: updating secret updates row without duplicating)
    const updatedSecret = 'updated-admin-secret-999';
    const run3 = await runSeedProcess({ ADMIN_SECRET: updatedSecret });
    t.equal(run3.exitCode, 0, 'seed script exits zero when updating secretHash on existing row');

    const adminCountAfterRun3 = await prisma.merchant.count({
      where: { id: TEST_ADMIN_ADDRESS },
    });
    t.equal(
      adminCountAfterRun3,
      1,
      'admin merchant still exists exactly once after secretHash update (upsert rather than duplicate)',
    );

    const adminRecordRun3 = await prisma.merchant.findUnique({
      where: { id: TEST_ADMIN_ADDRESS },
    });
    t.equal(
      adminRecordRun3?.secretHash,
      hashSecret(updatedSecret),
      'existing admin merchant secretHash was updated by upsert',
    );

    // Reset / clean test merchant before exit
    await prisma.merchant.deleteMany({
      where: { id: TEST_ADMIN_ADDRESS },
    });
  } catch (err: any) {
    t.fail(`unexpected error during seed idempotency test: ${err?.message || err}`);
  } finally {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch {
        // Ignore disconnect error
      }
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
    t.end();
  }
});
