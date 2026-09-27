/**
 * Shared Test Fixtures for API Gateway Test Suites.
 * 
 * Provides pre-configured, valid merchant, payment, and settlement objects
 * for seeding the mock Prisma database client during unit and integration tests.
 * 
 * The mock data includes active, soft-deleted, and boundary limit configurations
 * to ensure that Zod validation schemas and route logic are thoroughly tested.
 */

// Supported asset seed used by settlement tests (mirrors the #319 seed data).
export const MOCK_SUPPORTED_ASSET_USDC = {
  code: 'USDC',
  contractId: 'C_USDC_TEST_CONTRACT_ID',
  decimals: 6,
  name: 'USD Coin',
  isActive: true,
};

export const MOCK_STELLAR_KEY_1 = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
export const MOCK_STELLAR_KEY_2 = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
export const MOCK_STELLAR_KEY_3 = 'GC3O6JFSB7N66H4XEQNZG3EXK72CS2W4D5LSLG2R7EXXEZBXZZZZZZZZ'; // Custom boundary mock key
export const MOCK_STELLAR_KEY_4 = 'GD7V32JFSB7N66H4XEQNZG3EXK72CS2W4D5LSLG2R7EXXEZBXZYYYYYYYY'; // Custom boundary mock key

export const MOCK_MERCHANT_ACTIVE = {
  id: MOCK_STELLAR_KEY_1,
  name: 'BettaPay Active Merchant LLC',
  ownerId: 'owner-user-active-01',
  deletedAt: null,
  status: 'active' as const,
  settings: {
    feeBps: 100,
    autoSettle: true,
    preferredAsset: 'USDC',
    minSettlementAmount: '10.00',
    maxSettlementAmount: '5000.00',
    dailySettlementLimit: '10000.00',
  },
  secretHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // SHA-256 hash of empty string
};

export const MOCK_MERCHANT_DELETED = {
  id: MOCK_STELLAR_KEY_2,
  name: 'BettaPay Soft-Deleted Merchant LLC',
  ownerId: 'owner-user-deleted-02',
  deletedAt: new Date('2026-01-01T00:00:00.000Z'),
  status: 'active' as const,
  settings: {},
  secretHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

// Edge-case merchant with zero-fee configuration and extremely low settlement boundaries
export const MOCK_MERCHANT_ZERO_FEES = {
  id: MOCK_STELLAR_KEY_3,
  name: 'Zero Fees Micro-Merchant',
  ownerId: 'owner-user-zero-fees-03',
  deletedAt: null,
  status: 'active' as const,
  settings: {
    feeBps: 0,
    autoSettle: false,
    preferredAsset: 'XLM',
    minSettlementAmount: '0.01',
    maxSettlementAmount: '10.00',
    dailySettlementLimit: '50.00',
  },
  secretHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

// Edge-case merchant with high volume fees and large settlement limits
export const MOCK_MERCHANT_HIGH_VOLUME = {
  id: MOCK_STELLAR_KEY_4,
  name: 'High Volume Enterprise Corp',
  ownerId: 'owner-user-enterprise-04',
  deletedAt: null,
  status: 'active' as const,
  settings: {
    feeBps: 500, // 5% fee
    autoSettle: true,
    preferredAsset: 'EURT',
    minSettlementAmount: '500.00',
    maxSettlementAmount: '100000.00',
    dailySettlementLimit: '500000.00',
  },
  secretHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

// #317 — Merchant suspended via /api/merchants/:id/suspend. Existing data must
// remain readable; only the `status: 'suspended'` flag blocks new transactions.
export const MOCK_MERCHANT_SUSPENDED = {
  ...MOCK_MERCHANT_ACTIVE,
  status: 'suspended' as const,
};

export const MOCK_PAYMENT_INITIATED = {
  id: 'pay_initiated_001',
  merchantId: MOCK_STELLAR_KEY_1,
  payerId: 'payer-user-initiated-01',
  amount: '150.00',
  asset: 'USDC',
  status: 'initiated',
  reference: 'REF-INV-INIT-001',
  idempotencyKey: null,
  idempotencyKeyExpiresAt: null,
  createdAt: new Date('2026-07-20T10:00:00.000Z'),
};

export const MOCK_PAYMENT_COMPLETED = {
  id: 'pay_completed_002',
  merchantId: MOCK_STELLAR_KEY_1,
  payerId: 'payer-user-completed-02',
  amount: '250.50',
  asset: 'USDC',
  status: 'completed',
  reference: 'REF-INV-COMP-002',
  idempotencyKey: 'idemp-key-completed-02',
  idempotencyKeyExpiresAt: new Date('2026-07-21T10:00:00.000Z'),
  createdAt: new Date('2026-07-20T11:00:00.000Z'),
};

export const MOCK_PAYMENT_FAILED = {
  id: 'pay_failed_003',
  merchantId: MOCK_STELLAR_KEY_1,
  payerId: 'payer-user-failed-03',
  amount: '99.99',
  asset: 'USDC',
  status: 'failed',
  reference: 'REF-INV-FAIL-003',
  idempotencyKey: 'idemp-key-failed-03',
  idempotencyKeyExpiresAt: new Date('2026-07-21T12:00:00.000Z'),
  createdAt: new Date('2026-07-20T12:00:00.000Z'),
};

export const MOCK_SETTLEMENT_PENDING = {
  id: 'set_pending_001',
  merchantId: MOCK_STELLAR_KEY_1,
  totalAmount: '500.00',
  status: 'PENDING',
  completedAt: null,
  initiatedAt: new Date('2026-07-22T08:00:00.000Z'),
};

export const MOCK_SETTLEMENT_COMPLETED = {
  id: 'set_completed_002',
  merchantId: MOCK_STELLAR_KEY_1,
  totalAmount: '1250.00',
  status: 'COMPLETED',
  completedAt: new Date('2026-07-22T09:30:00.000Z'),
  initiatedAt: new Date('2026-07-22T09:00:00.000Z'),
};

// Settlement representation for test configurations checking multy currency rates
export const MOCK_SETTLEMENT_FOREIGN_CURRENCY = {
  id: 'set_foreign_003',
  merchantId: MOCK_STELLAR_KEY_1,
  totalAmount: '15000.00',
  status: 'PROCESSING',
  completedAt: null,
  initiatedAt: new Date('2026-07-22T10:00:00.000Z'),
};
