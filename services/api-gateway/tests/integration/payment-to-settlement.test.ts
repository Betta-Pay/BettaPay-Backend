import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { buildApp } from '../../src/index.js';
import { generateTestJwt, createMockSettlementClient } from '../../src/test-utils.js';
import { createSettlementClient } from '../../src/clients/settlement-client.js';

// ── Environment Configuration ──────────────────────────────────────────────────
process.env.JWT_SECRET ||= 'super-secret-development-key-please-change';
process.env.GOOGLE_CLIENT_ID ||= 'local-dev-google-client';
process.env.INTER_SERVICE_SECRET ||= 'dev-inter-service-secret';
process.env.DATABASE_URL ||= process.env.DATABASE_URL_TEST || 'postgresql://postgres:postgres@localhost:5432/bettapay_test?schema=public';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.SETTLEMENT_CONTRACT_ID ||= 'CA_TEST';
process.env.GOVERNANCE_CONTRACT_ID ||= 'GA_TEST';
process.env.ADMIN_ADDRESS ||= 'GA_TEST';
process.env.ADMIN_SECRET ||= 'test-secret';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;

// ── Database & Redis Clients ───────────────────────────────────────────────────
function createTestPrismaClient() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return { prisma: new PrismaClient({ adapter }), pool };
}

// Helper: poll until an async predicate returns true or timeout expires
async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
  intervalMs = 200
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// ── Main Integration Test Suite ───────────────────────────────────────────────

test('End-to-End Integration: Payment-to-Settlement Lifecycle', async (t) => {
  const { prisma, pool } = createTestPrismaClient();
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

  // 1. Verify DB & Redis reachability
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
  } catch (err) {
    t.skip(`PostgreSQL or Redis unavailable at ${DATABASE_URL} / ${REDIS_URL}: ${err}`);
    await pool.end();
    await redis.quit();
    return;
  }

  // 2. Setup Mock Webhook Receiver
  const webhookApp = Fastify();
  const receivedWebhooks: Array<{ headers: Record<string, unknown>; body: any }> = [];

  webhookApp.post('/webhook', async (req, reply) => {
    receivedWebhooks.push({
      headers: req.headers as Record<string, unknown>,
      body: req.body,
    });
    return reply.code(200).send({ received: true });
  });

  const webhookAddress = await webhookApp.listen({ port: 0, host: '127.0.0.1' });

  // 3. Clean database tables for clean test state
  await prisma.settlement.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.merchant.deleteMany({});
  await prisma.supportedAsset.deleteMany({});
  await prisma.auditLog.deleteMany({});

  // Seed active supported asset USDC
  await prisma.supportedAsset.create({
    data: {
      code: 'USDC',
      contractId: 'C_USDC_TEST_CONTRACT_ID',
      decimals: 6,
      name: 'USD Coin',
      isActive: true,
    },
  });

  // 4. Create Settlement Engine instance (simulated downstream service for integration)
  // Settlement engine handler mock/bridge using real DB and calculations. Built
  // on the centralized createMockSettlementClient so the suite shares one
  // mock-builder source (issue #557).
  const mockSettlementClient = createMockSettlementClient({
    createSettlement: async (payload: any) => {
      const { merchantId, amount, asset, items } = payload;
      const settlementItems = items || [{ amount, asset }];
      const primaryItem = settlementItems[0];

      // Verify merchant exists
      const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
      if (!merchant) {
        return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Merchant not found' } }, contentType: 'application/json' };
      }

      // Check supported assets
      for (const item of settlementItems) {
        const supported = await prisma.supportedAsset.findUnique({ where: { code: item.asset } });
        if (!supported || !supported.isActive) {
          return { status: 422, body: { error: { code: 'VALIDATION_ERROR', message: `Asset ${item.asset} is not supported` } }, contentType: 'application/json' };
        }
      }

      // Calculate fee based on merchant settings
      const settings = (merchant.settings ?? {}) as Record<string, any>;
      const feeBps = typeof settings.feeBps === 'number' ? settings.feeBps : 100;
      const webhookUrl = settings.webhookUrl ?? `${webhookAddress}/webhook`;

      // Check min settlement amount
      if (settings.minSettlementAmount) {
        const minAmt = parseFloat(settings.minSettlementAmount);
        if (parseFloat(primaryItem.amount) < minAmt) {
          return {
            status: 422,
            body: { error: { code: 'VALIDATION_ERROR', message: `Settlement amount ${primaryItem.amount} is below minimum ${settings.minSettlementAmount}` } },
            contentType: 'application/json',
          };
        }
      }

      const grossNum = parseFloat(primaryItem.amount);
      const feeNum = (grossNum * feeBps) / 10000;
      const netNum = grossNum - feeNum;

      const grossAmount = primaryItem.amount;
      const feeAmount = feeNum.toFixed(2);
      const netAmount = netNum.toFixed(2);
      const settlementId = 'set_' + crypto.randomUUID().replace(/-/g, '');

      const settlement = await prisma.settlement.create({
        data: {
          id: settlementId,
          merchantId,
          totalAmount: grossAmount,
          grossAmount,
          feeAmount,
          netAmount,
          feeBps,
          asset: primaryItem.asset,
          status: 'pending',
          webhookUrl,
          feeSnapshot: {
            feeBpsApplied: feeBps,
            maxFeeBpsApplied: feeBps,
            discountApplied: 0,
            monthlyVolumeAtTime: 0,
            feeVersion: '1.0',
          },
        },
      });

      // Asynchronously process settlement (simulating worker job transition)
      setTimeout(async () => {
        const updated = await prisma.settlement.update({
          where: { id: settlementId },
          data: { status: 'completed', completedAt: new Date() },
        });

        // Deliver webhook to target URL
        if (updated.webhookUrl) {
          try {
            await fetch(updated.webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                event: 'settlement.completed',
                data: updated,
              }),
            });
          } catch (e) {
            // Log error
          }
        }
      }, 50);

      return { status: 201, body: { data: settlement }, contentType: 'application/json' };
    },
  });

  // 5. Build API Gateway with real Prisma and mock settlement client bridge
  const app = buildApp({
    prisma,
    settlementClient: mockSettlementClient as any,
    logger: false,
  });
  await app.ready();

  const merchantStellarId = 'GC66IZZ6AKNEVGJDBSGCX7RO6FUKUB3HEAR65NHMWAYYPDDHUIGTTUHA';
  const ownerId = 'GCFDDJLNBB7YVSMGAMPV5W7NQCWB6BF6EBA7GHVXMAGYGRZ6VH7R5YRQ';
  const authToken = generateTestJwt(app, { merchantId: merchantStellarId, ownerId });

  let createdPaymentId = '';
  let createdSettlementId = '';

  // ── Step 1: Create merchant ──────────────────────────────────────────────────
  await t.test('1. Create merchant via API Gateway', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/merchants',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        id: merchantStellarId,
        name: 'BettaPay E2E Merchant Store',
        ownerId: ownerId,
        settings: {
          feeBps: 150, // 1.5% fee
          webhookUrl: `${webhookAddress}/webhook`,
          minSettlementAmount: 10,
        },
      },
    });

    assert.equal(res.statusCode, 201, 'Merchant creation must return HTTP 201');
    const body = JSON.parse(res.body);
    assert.ok(body.data, 'Response envelope must contain data');
    assert.equal(body.data.merchant.id, merchantStellarId);
    assert.equal(body.data.merchant.name, 'BettaPay E2E Merchant Store');
    assert.ok(typeof body.data.secret === 'string', 'API must return merchant secret');
  });

  // ── Step 2: Verify merchant persistence ─────────────────────────────────────
  await t.test('2. Verify merchant persistence in PostgreSQL database', async () => {
    // API verification
    const apiRes = await app.inject({
      method: 'GET',
      url: `/api/merchants/${merchantStellarId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.equal(apiRes.statusCode, 200, 'GET /api/merchants/:id must return HTTP 200');

    // Direct DB assertion
    const merchantDb = await prisma.merchant.findUnique({ where: { id: merchantStellarId } });
    assert.ok(merchantDb, 'Merchant must exist in PostgreSQL database');
    assert.equal(merchantDb.name, 'BettaPay E2E Merchant Store');
    assert.equal(merchantDb.ownerId, ownerId);
    assert.equal(merchantDb.deletedAt, null, 'Deleted timestamp must be null');
    assert.equal((merchantDb.settings as any).feeBps, 150);
  });

  // ── Step 3: Initiate payment ─────────────────────────────────────────────────
  await t.test('3. Initiate payment session via API Gateway', async () => {
    const idempotencyKey = `idem-e2e-${crypto.randomUUID()}`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: {
        authorization: `Bearer ${authToken}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        merchantId: merchantStellarId,
        payerId: 'GC6ZAFBMPLT7XDWA5DTJGMTQIZVK2JU6B45G76ITQIOERDMYYMSA223Q',
        amount: '100.00',
        asset: 'USDC',
        reference: 'INV-2026-001',
      },
    });

    assert.equal(res.statusCode, 201, 'Payment creation must return HTTP 201');
    const body = JSON.parse(res.body);
    assert.ok(body.data, 'Response envelope must contain data');
    assert.ok(body.data.id.startsWith('pay_'), 'Payment ID must start with pay_');
    assert.ok(body.data.amount, 'Payment amount is present');
    assert.equal(body.data.asset, 'USDC');
    assert.equal(body.data.status, 'initiated');

    createdPaymentId = body.data.id;
  });

  // ── Step 4: Validate payment creation ───────────────────────────────────────
  await t.test('4. Validate payment creation in PostgreSQL database', async () => {
    const paymentDb = await prisma.payment.findUnique({ where: { id: createdPaymentId } });
    assert.ok(paymentDb, 'Payment record must be persisted in PostgreSQL database');
    assert.equal(paymentDb.merchantId, merchantStellarId);
    assert.equal(paymentDb.status, 'initiated');
    assert.equal(Number(paymentDb.amount), 100, 'Amount must be 100.00');
    assert.equal(paymentDb.asset, 'USDC');
  });

  // ── Step 5: Complete payment ─────────────────────────────────────────────────
  await t.test('5. Complete payment session via API Gateway', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/payments/${createdPaymentId}/status`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { status: 'completed' },
    });

    assert.equal(res.statusCode, 200, 'Status transition to completed must return HTTP 200');
    const body = JSON.parse(res.body);
    assert.equal(body.data.status, 'completed');
  });

  // ── Step 6: Verify payment status transition ─────────────────────────────────
  await t.test('6. Verify payment status transition & invalid transition error handling', async () => {
    // DB verification
    const paymentDb = await prisma.payment.findUnique({ where: { id: createdPaymentId } });
    assert.ok(paymentDb);
    assert.equal(paymentDb.status, 'completed', 'Payment status in DB must be updated to completed');

    // Error handling test: invalid state transition from completed -> failed
    const invalidRes = await app.inject({
      method: 'PATCH',
      url: `/api/payments/${createdPaymentId}/status`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { status: 'failed' },
    });

    assert.equal(invalidRes.statusCode, 422, 'Invalid transition completed -> failed must return HTTP 422');
    const errBody = JSON.parse(invalidRes.body);
    assert.ok(errBody.error, 'Invalid transition response must contain error');
    assert.equal(errBody.error.code, 'VALIDATION_ERROR');
  });

  // ── Step 7: Trigger settlement process ─────────────────────────────────────
  await t.test('7. Trigger settlement process via API Gateway', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settlements',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        merchantId: merchantStellarId,
        items: [{ amount: '100.00', asset: 'USDC' }],
      },
    });

    assert.equal(res.statusCode, 201, 'Settlement creation must return HTTP 201');
    const body = JSON.parse(res.body);
    assert.ok(body.data, 'Response envelope must contain data');
    assert.ok(body.data.id.startsWith('set_'), 'Settlement ID must start with set_');
    assert.equal(body.data.status, 'pending');

    createdSettlementId = body.data.id;
  });

  // ── Step 8: Verify settlement creation ─────────────────────────────────────
  await t.test('8. Verify settlement creation in PostgreSQL database', async () => {
    const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
    assert.ok(settlementDb, 'Settlement record must exist in PostgreSQL database');
    assert.equal(settlementDb.merchantId, merchantStellarId);
    assert.equal(settlementDb.asset, 'USDC');
  });

  // ── Step 9: Verify settlement amount ─────────────────────────────────────────
  await t.test('9. Verify gross settlement amount', async () => {
    const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
    assert.ok(settlementDb);
    assert.equal(settlementDb.grossAmount, '100.00', 'Gross amount must match requested 100.00');
  });

  // ── Step 10: Verify fee calculation ─────────────────────────────────────────
  await t.test('10. Verify fee calculation (150 BPS = 1.5%)', async () => {
    const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
    assert.ok(settlementDb);
    assert.equal(settlementDb.feeBps, 150, 'Fee BPS must be 150');
    assert.equal(settlementDb.feeAmount, '1.50', 'Fee amount must be exactly 1.50 (1.5% of 100.00)');
    assert.ok(settlementDb.feeSnapshot, 'Fee audit snapshot must be stored in database');
  });

  // ── Step 11: Verify merchant receives expected net amount ────────────────────
  await t.test('11. Verify merchant net amount & mathematical invariants', async () => {
    const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
    assert.ok(settlementDb);
    assert.equal(settlementDb.netAmount, '98.50', 'Net amount must be 98.50 (100.00 gross - 1.50 fee)');

    const gross = parseFloat(settlementDb.grossAmount);
    const fee = parseFloat(settlementDb.feeAmount);
    const net = parseFloat(settlementDb.netAmount);

    assert.equal(gross - fee, net, 'Invariant gross - fee == net must hold exactly');
  });

  // ── Step 12: Simulate webhook delivery ──────────────────────────────────────
  await t.test('12. Wait for settlement processing and webhook delivery trigger', async () => {
    const delivered = await waitUntil(async () => {
      const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
      return settlementDb?.status === 'completed' && receivedWebhooks.length > 0;
    }, 5000, 100);

    assert.ok(delivered, 'Settlement status must transition to completed and trigger webhook delivery');
  });

  // ── Step 13: Verify webhook payload ─────────────────────────────────────────
  await t.test('13. Verify webhook payload contents', async () => {
    assert.ok(receivedWebhooks.length > 0, 'Webhook receiver must have received at least one webhook');
    const webhook = receivedWebhooks[0];
    assert.equal(webhook.body.event, 'settlement.completed', 'Webhook event must be settlement.completed');
    assert.equal(webhook.body.data.id, createdSettlementId, 'Webhook payload data ID must match settlement ID');
    assert.equal(webhook.body.data.grossAmount, '100.00');
    assert.equal(webhook.body.data.feeAmount, '1.50');
    assert.equal(webhook.body.data.netAmount, '98.50');
  });

  // ── Step 14: Verify webhook delivery succeeds ──────────────────────────────
  await t.test('14. Verify webhook delivery succeeded', async () => {
    const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
    assert.ok(settlementDb);
    assert.equal(settlementDb.status, 'completed', 'Settlement status in DB must be completed');
    assert.ok(settlementDb.completedAt !== null, 'Completed timestamp must be set');
  });

  // ── Step 15: Confirm final persisted state ──────────────────────────────────
  await t.test('15. Confirm final persisted state across system & Redis', async () => {
    const merchantDb = await prisma.merchant.findUnique({ where: { id: merchantStellarId } });
    const paymentDb = await prisma.payment.findUnique({ where: { id: createdPaymentId } });
    const settlementDb = await prisma.settlement.findUnique({ where: { id: createdSettlementId } });
    const auditLogs = await prisma.auditLog.findMany({ where: { actorId: undefined } });

    assert.ok(merchantDb, 'Merchant must remain persisted');
    assert.equal(paymentDb?.status, 'completed', 'Payment must be completed in DB');
    assert.equal(settlementDb?.status, 'completed', 'Settlement must be completed in DB');
    assert.ok(auditLogs.length > 0, 'Audit logs must be written for major lifecycle events');
  });

  // ── Error Handling Tests ──────────────────────────────────────────────────────
  await t.test('Error Handling: Settlement below minimum amount returns 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settlements',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        merchantId: merchantStellarId,
        items: [{ amount: '5.00', asset: 'USDC' }], // min is 10.00
      },
    });

    assert.equal(res.statusCode, 422, 'Settlement below min amount must return 422');
    const body = JSON.parse(res.body);
    assert.ok(body.error, 'Response must contain error object');
    assert.ok(body.error.message.includes('below minimum'));
  });

  await t.test('Error Handling: Unsupported asset returns 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settlements',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        merchantId: merchantStellarId,
        items: [{ amount: '100.00', asset: 'EURT' }],
      },
    });

    assert.equal(res.statusCode, 422, 'Unsupported asset settlement must return 422');
  });

  // Clean up test instances
  await app.close();
  await webhookApp.close();
  await pool.end();
  await redis.quit();
});
