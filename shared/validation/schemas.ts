import { z } from 'zod';
import { CurrencyCode } from './currency.js';
export { CurrencyCode };
import { validateStellarAddress } from '@bettapay/stellar-utils';
import { WebhookUrlSchema } from './webhookSchema.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// Entity schemas
export const idSchema = z.string().min(1);
export const isoDateString = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid ISO date string' });

export const AmountString = z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a numeric string');
export const PositiveAmountString = AmountString.refine(
  (val) => {
    const parsed = parseFloat(val);
    return !isNaN(parsed) && parsed > 0;
  },
  { message: 'Amount must be greater than zero' }
);

/** Settlement amounts must not exceed 10^15 (1,000,000,000,000,000). */
export const SettlementAmountString = AmountString.refine(
  (val) => {
    const max = '1000000000000000';
    const [intPart, decPart] = val.split('.');
    if (intPart.length > max.length) return false;
    if (intPart.length < max.length) return true;
    // Same integer-part length — compare lexicographically (safe for same-length digit strings)
    if (intPart > max) return false;
    if (intPart < max) return true;
    // Integer parts are identical — decimal part must be all zeros (or absent)
    return !decPart || /^0+$/.test(decPart);
  },
  { message: 'Settlement amount exceeds maximum allowed (1,000,000,000,000,000)' },
);

export const StellarAddressSchema = z.string().refine(validateStellarAddress, {
  message: 'Invalid Stellar public key',
});
export type StellarAddress = z.infer<typeof StellarAddressSchema>;

export const userSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  displayName: z.string().optional(),
  createdAt: isoDateString,
  metadata: z.record(z.any()).optional()
});

export const GoogleAuthBody = z.object({
  idToken: z.string().min(1)
});
export type GoogleAuthBody = z.infer<typeof GoogleAuthBody>;

export const WalletChallengeQuery = z.object({
  address: StellarAddressSchema
});
export type WalletChallengeQuery = z.infer<typeof WalletChallengeQuery>;

export const WalletVerifyBody = z.object({
  address: StellarAddressSchema,
  nonce: z.string().min(1, 'nonce is required').max(512, 'nonce is too long'),
  signature: z.string().min(1, 'signature is required'),
  challenge: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});
export type WalletVerifyBody = z.infer<typeof WalletVerifyBody>;

export const merchantSchema = z.object({
  id: idSchema,
  name: z.string(),
  ownerId: StellarAddressSchema,
  createdAt: isoDateString,
  deletedAt: isoDateString.optional(),
  // #317 — suspension status; 'active' by default. Suspended merchants cannot
  // create payments or settlements, but existing data remains readable.
  status: z.enum(['active', 'suspended']).default('active'),
  settings: z.record(z.any()).optional()
});

// Fee rule extracted from merchant settings (feeBps in basis points, 0-10000)
export const FeeRule = z.object({
  feeBps: z.number().int().min(0).max(10000),
  tier: z.string().optional(),
});
export type FeeRule = z.infer<typeof FeeRule>;

export const walletSchema = z.object({
  id: idSchema,
  ownerId: StellarAddressSchema,
  address: StellarAddressSchema,
  asset: z.string(),
  balance: z.string()
});

export const transactionSchema = z.object({
  id: idSchema,
  type: z.enum(['payment','settlement','anchor_transfer','fx']),
  amount: z.string(),
  asset: CurrencyCode,
  from: CurrencyCode.nullable(),
  to: CurrencyCode.nullable(),
  createdAt: isoDateString,
  metadata: z.record(z.any()).optional()
});

export const paymentSchema = z.object({
  id: idSchema,
  merchantId: StellarAddressSchema,
  payerId: StellarAddressSchema.optional(),
  amount: z.string(),
  asset: CurrencyCode,
  status: z.enum(['initiated','completed','failed','cancelled']),
  createdAt: isoDateString,
  reference: z.string().optional(),
  metadata: z.record(z.any()).optional()
});

export const settlementSchema = z.object({
  id: idSchema,
  merchantId: StellarAddressSchema,
  totalAmount: z.string(),
  grossAmount: z.string(),
  feeAmount: z.string(),
  netAmount: z.string(),
  feeBps: z.number(),
  asset: CurrencyCode,
  batchId: z.string().optional(),
  initiatedAt: isoDateString,
  completedAt: isoDateString.optional(),
  status: z.enum(['pending','processing','completed','failed']),
  feeSnapshot: z.object({
    feeBpsApplied: z.number(),
    maxFeeBpsApplied: z.number(),
    discountApplied: z.number(),
    monthlyVolumeAtTime: z.number(),
    feeVersion: z.string(),
  }).optional(),
});

export const fxQuoteSchema = z.object({
  id: idSchema,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: z.string(),
  expiresAt: isoDateString,
  rateBatchId: z.string().uuid(),
  slippageBps: z.number().int().min(0).optional(),
});

export const billPaymentSchema = z.object({
  id: idSchema,
  merchantId: StellarAddressSchema,
  amount: z.string(),
  asset: CurrencyCode,
  billerReference: z.string(),
  status: z.enum(['initiated','paid','failed']),
  createdAt: isoDateString
});

export const anchorTransferSchema = z.object({
  id: idSchema,
  anchorName: z.string(),
  amount: z.string(),
  asset: CurrencyCode,
  externalReference: z.string().optional(),
  status: z.enum(['pending','completed','failed']),
  createdAt: isoDateString
});

// Event schemas
export const paymentInitiatedEvent = z.object({
  id: idSchema,
  type: z.literal('PaymentInitiated'),
  occurredAt: isoDateString,
  payload: z.object({ payment: paymentSchema })
});

export const paymentCompletedEvent = z.object({
  id: idSchema,
  type: z.literal('PaymentCompleted'),
  occurredAt: isoDateString,
  payload: z.object({ payment: paymentSchema, transaction: transactionSchema })
});

export const settlementTriggeredEvent = z.object({
  id: idSchema,
  type: z.literal('SettlementTriggered'),
  occurredAt: isoDateString,
  payload: z.object({ settlement: settlementSchema })
});

export const fxExecutedEvent = z.object({
  id: idSchema,
  type: z.literal('FXExecuted'),
  occurredAt: isoDateString,
  payload: z.object({ quote: fxQuoteSchema, transaction: transactionSchema })
});

export const billPaidEvent = z.object({
  id: idSchema,
  type: z.literal('BillPaid'),
  occurredAt: isoDateString,
  payload: z.object({ billPayment: billPaymentSchema })
});

export const anchorSettledEvent = z.object({
  id: idSchema,
  type: z.literal('AnchorSettled'),
  occurredAt: isoDateString,
  payload: z.object({ anchorTransfer: anchorTransferSchema })
});

export const eventSchemas = z.discriminatedUnion('type', [
  paymentInitiatedEvent,
  paymentCompletedEvent,
  settlementTriggeredEvent,
  fxExecutedEvent,
  billPaidEvent,
  anchorSettledEvent
]);

// Export types inferred from schemas
export type User = z.infer<typeof userSchema>;
export type Merchant = z.infer<typeof merchantSchema>;
export type Wallet = z.infer<typeof walletSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Settlement = z.infer<typeof settlementSchema>;
export type FXQuote = z.infer<typeof fxQuoteSchema>;
export type BillPayment = z.infer<typeof billPaymentSchema>;
export type AnchorTransfer = z.infer<typeof anchorTransferSchema>;
export type EventPayloads = z.infer<typeof eventSchemas>;

// Convenience parsers
export function parseEvent(raw: unknown) {
  return eventSchemas.parse(raw);
}

export function safeParseEvent(raw: unknown) {
  return eventSchemas.safeParse(raw);
}

// ─── Webhook URL validation ───────────────────────────────────────────────────

// Canonical WebhookUrlSchema now lives in ./webhookSchema.ts (imported above)
// and is re-exported from the package root via index.ts's
// `export * from './webhookSchema.js'`. It is only imported here (not
// re-exported) to avoid a duplicate-export collision in index.ts's barrel

// ─── Health Check Schemas ──────────────────────────────────────────────────────

export const HealthStatus = z.enum(['healthy', 'degraded', 'unhealthy']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const DependencyConnectionStatus = z.enum(['connected', 'disconnected']);
export type DependencyConnectionStatus = z.infer<typeof DependencyConnectionStatus>;

export const DependencyHealth = z.object({
  name: z.string(),
  status: DependencyConnectionStatus,
  latencyMs: z.number().optional(),
  details: z.record(z.unknown()).optional(),
});
export type DependencyHealth = z.infer<typeof DependencyHealth>;

export const HealthResponse = z.object({
  status: HealthStatus,
  service: z.string(),
  version: z.string(),
  uptime: z.number(),
  lastDependencyCheck: z.string(),
  dependencies: z.array(DependencyHealth),
  upstream: z.array(DependencyHealth).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ServiceHealthSnapshot = z.object({
  status: HealthStatus,
  service: z.string().optional(),
  version: z.string().optional(),
  uptime: z.number().optional(),
  lastDependencyCheck: z.string().optional(),
  dependencies: z.array(DependencyHealth).optional(),
  upstream: z.array(DependencyHealth).optional(),
  error: z.string().optional(),
});
export type ServiceHealthSnapshot = z.infer<typeof ServiceHealthSnapshot>;

export const AggregatedHealthResponse = z.object({
  status: HealthStatus,
  service: z.literal('api-gateway'),
  version: z.string(),
  uptime: z.number(),
  lastDependencyCheck: z.string(),
  dependencies: z.array(DependencyHealth),
  upstream: z.array(DependencyHealth).optional(),
  services: z.record(ServiceHealthSnapshot),
});
export type AggregatedHealthResponse = z.infer<typeof AggregatedHealthResponse>;

// ─── Request Body Schemas (used by API Gateway route handlers) ────────────────

// Idempotency key must be a valid UUID v4 (e.g. "550e8400-e29b-41d4-a716-446655440000").
// Clients should generate a new key per unique operation and reuse the same key
// on retries so the server can safely deduplicate requests.
export const IdempotencyKeySchema = z.string().uuid({ message: 'idempotencyKey must be a valid UUID' });
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const MerchantSettings = z.object({
  feeBps: z.number().int().min(0).max(10000).optional(),
  maxFeeBps: z.number().int().min(0).max(10000).optional(),
  maxFeeThreshold: z.string().regex(/^\d+(\.\d+)?$/, 'maxFeeThreshold must be a numeric string').optional(),
  webhookUrl: WebhookUrlSchema.optional(),
  preferredAsset: CurrencyCode.optional(),
  autoSettle: z.boolean().optional(),
  maxSettlementAmount: z.number().positive().optional(),
  minSettlementAmount: z.number().positive().optional(),
  dailySettlementLimit: z.number().positive().optional(),
  businessName: z.string().max(100, 'businessName must be at most 100 characters').transform(escapeHtml).optional(),
  supportEmail: z.string().email('Invalid supportEmail format').max(255, 'supportEmail must be at most 255 characters').optional(),
  supportAddress: z.string().max(255, 'supportAddress must be at most 255 characters').transform(escapeHtml).optional(),
  tier: z.string().max(50, 'tier must be at most 50 characters').transform(escapeHtml).optional(),
});

export type MerchantSettings = z.infer<typeof MerchantSettings>;

export const CreateMerchantBody = z.object({
  id: z.string().min(1, 'id is required'),
  name: z.string().min(1, 'name is required'),
  ownerId: StellarAddressSchema, // validated Stellar public key
  settings: MerchantSettings.optional(),
  secret: z.string().min(20, 'secret must be at least 20 characters').optional(),
});

export const CreatePaymentBody = z.object({
  merchantId: StellarAddressSchema,
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a numeric string'),
  asset: CurrencyCode,
  convertTo: CurrencyCode.optional(),
  payerId: z.string().optional(),
  reference: z.string().optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
});

export const CreateSettlementBody = z.object({
  merchantId: z.string().regex(/^[A-Za-z0-9_]+$/,"Invalid merchantId"),
  amount: SettlementAmountString.optional(),
  asset: CurrencyCode.optional(),
  items: z.array(z.object({
    amount: SettlementAmountString,
    asset: CurrencyCode,
  })).optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
}).refine((data) => {
  // Either single amount/asset OR items array must be provided, not both
  const hasSingleAsset = data.amount && data.asset;
  const hasItems = data.items && data.items.length > 0;
  return (hasSingleAsset && !hasItems) || (!hasSingleAsset && hasItems);
}, {
  message: 'Provide either amount/asset OR items array, not both',
});

export const BulkSettlementBody = z.object({
  merchantId: z.string().regex(/^[A-Za-z0-9_]+$/,"Invalid merchantId"),
  settlements: z.array(z.object({
    amount: SettlementAmountString,
    asset: CurrencyCode,
  })),
});

export const AuthTokenBody = z.object({
  merchantId: StellarAddressSchema,
  secret: z.string().min(1, 'secret is required'),
});

export const AuthIpScoreQuery = z.object({
  ip: z.string().min(1, 'ip is required'),
});

export const WebhookTestStatus = z.enum(['success', 'failed']);

export const WebhookTestPayloadSchema = z.object({
  type: z.literal('test'),
  timestamp: isoDateString,
  subscriptionId: idSchema,
  test: z.literal(true),
});

export const WebhookTestResultSchema = z.object({
  success: z.boolean(),
  statusCode: z.number().int().min(100).max(599).optional(),
  error: z.string().optional(),
});

export const WebhookSubscriptionSchema = z.object({
  id: idSchema,
  url: z.string().url(),
  createdAt: isoDateString,
  lastTestedAt: isoDateString.nullable().optional(),
  lastTestStatus: WebhookTestStatus.nullable().optional(),
  lastTestStatusCode: z.number().int().min(100).max(599).nullable().optional(),
});

// A payment may only be moved into a terminal state. `initiated` is never an
// accepted target (payments start there at creation), so it is excluded here.
export const UpdatePaymentStatusBody = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
});

export const UpdateSettlementStatusBody = z.object({
  status: z.enum(['processing', 'completed', 'failed']),
});
export type UpdateSettlementStatusBody = z.infer<typeof UpdateSettlementStatusBody>;

// ─── Status transition state machines ─────────────────────────────────────────
// These maps define which status transitions are valid for payments and
// settlements. Any transition not in the map is rejected with 422.

export const PAYMENT_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  initiated: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const SETTLEMENT_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export function isValidTransition(
  transitions: Record<string, readonly string[]>,
  from: string,
  to: string,
): boolean {
  const allowed = transitions[from] ?? [];
  return allowed.includes(to);
}

// Per-merchant fee rule configuration. feeBps is basis points (1% = 100 bps),
// capped at 10000 (100%). Unknown keys are stripped; the route merges these into
// the merchant's existing settings rather than replacing them.
export const UpdateMerchantSettingsBody = z.object({
  feeBps: z.number().int().min(0).max(10000).optional(),
  maxFeeBps: z.number().int().min(0).max(10000).optional(),
  maxFeeThreshold: z.string().regex(/^\d+(\.\d+)?$/, 'maxFeeThreshold must be a numeric string').optional(),
  tier: z.string().max(50, 'tier must be at most 50 characters').transform(escapeHtml).optional(),
  minSettlementAmount: z.string().regex(/^\d+(\.\d+)?$/, 'minSettlementAmount must be a numeric string').optional(),
  maxSettlementAmount: z.string().regex(/^\d+(\.\d+)?$/, 'maxSettlementAmount must be a numeric string').optional(),
  dailySettlementLimit: z.string().regex(/^\d+(\.\d+)?$/, 'dailySettlementLimit must be a numeric string').optional(),
  webhookUrl: WebhookUrlSchema.optional(),
  preferredAsset: CurrencyCode.optional(),
  autoSettle: z.boolean().optional(),
  businessName: z.string().max(100, 'businessName must be at most 100 characters').transform(escapeHtml).optional(),
  supportEmail: z.string().email('Invalid supportEmail format').max(255, 'supportEmail must be at most 255 characters').optional(),
  supportAddress: z.string().max(255, 'supportAddress must be at most 255 characters').transform(escapeHtml).optional(),
});

export const UpdateMerchantNameBody = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters')
});
export type UpdateMerchantNameBody = z.infer<typeof UpdateMerchantNameBody>;

export const KycStatusEnum = z.enum(['unverified', 'pending', 'verified', 'rejected']);
export type KycStatusEnum = z.infer<typeof KycStatusEnum>;

export const UpdateMerchantKycBody = z.object({
  kycStatus: KycStatusEnum,
});
export type UpdateMerchantKycBody = z.infer<typeof UpdateMerchantKycBody>;

export const SupportedAssetSchema = z.object({
  code: z.string().min(1),
  contractId: z.string().min(1),
  decimals: z.number().int().min(0),
  name: z.string().min(1),
  isActive: z.boolean(),
});
export type SupportedAsset = z.infer<typeof SupportedAssetSchema>;

export const RateOverrideBody = z.object({
  rates: z.record(z.string(), z.number().positive()),
});
export type RateOverrideBody = z.infer<typeof RateOverrideBody>;

export const CreateSupportedAssetBody = z.object({
  code: z.string().min(1),
  contractId: z.string().min(1),
  decimals: z.number().int().min(0),
  name: z.string().min(1),
  isActive: z.boolean().default(true),
});
export type CreateSupportedAssetBody = z.infer<typeof CreateSupportedAssetBody>;

export const UpdateSupportedAssetBody = z.object({
  contractId: z.string().min(1).optional(),
  decimals: z.number().int().min(0).optional(),
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateSupportedAssetBody = z.infer<typeof UpdateSupportedAssetBody>;

export const BulkCancelPaymentsBody = z.object({
  paymentIds: z.array(z.string().min(1)).min(1, 'At least one payment ID is required').max(100, 'Maximum 100 payment IDs allowed'),
});
export type BulkCancelPaymentsBody = z.infer<typeof BulkCancelPaymentsBody>;

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const EventListQuery = PaginationQuery.extend({
  type: z.string().optional(),
  topic: z.string().optional(),
  contractId: z.string().optional(),
  fromLedger: z.coerce.number().int().min(1).optional(),
  toLedger: z.coerce.number().int().min(1).optional(),
}).refine(
  (data) => {
    if (data.fromLedger !== undefined && data.toLedger !== undefined) {
      return data.fromLedger <= data.toLedger;
    }
    return true;
  },
  { message: "fromLedger must be <= toLedger" }
);
export type EventListQuery = z.infer<typeof EventListQuery>;

export const SettlementListQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  includeDeleted: z.coerce.boolean().default(false),
}).refine(
  (data) => {
    const start = data.startDate ?? data.from;
    const end = data.endDate ?? data.to;
    if (end && !start) return false;
    if (start && end && start > end) return false;
    return true;
  },
  { message: 'endDate requires startDate; startDate must be before endDate' }
);
export type SettlementListQuery = z.infer<typeof SettlementListQuery>;

export const DateRangeQuery = z
  .object({
    from: isoDateString.optional(),
    to: isoDateString.optional().default(() => new Date().toISOString())
  })
  .refine(
    (data) => !data.from || !data.to || data.from <= data.to,
    { message: "from must be before to" }
  );
export type DateRangeQuery = z.infer<typeof DateRangeQuery>;

export type CreateMerchantBody = z.infer<typeof CreateMerchantBody>;
export type CreatePaymentBody = z.infer<typeof CreatePaymentBody>;
export type CreateSettlementBody = z.infer<typeof CreateSettlementBody>;
export type BulkSettlementBody = z.infer<typeof BulkSettlementBody>;
export type AuthTokenBody = z.infer<typeof AuthTokenBody>;
export type AuthIpScoreQuery = z.infer<typeof AuthIpScoreQuery>;
export type WebhookTestStatus = z.infer<typeof WebhookTestStatus>;
export type WebhookTestPayload = z.infer<typeof WebhookTestPayloadSchema>;
export type WebhookTestResult = z.infer<typeof WebhookTestResultSchema>;
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;
export type UpdatePaymentStatusBody = z.infer<typeof UpdatePaymentStatusBody>;
export type UpdateMerchantSettingsBody = z.infer<typeof UpdateMerchantSettingsBody>;

// ─── Indexer cleanup query ─────────────────────────────────────────────────────

export const CleanupQuery = z.object({
  dryRun: z.coerce.boolean().default(false),
});
export type CleanupQuery = z.infer<typeof CleanupQuery>;

export interface CleanupDryRunResult {
  wouldDelete: number;
  totalSizeBytes: number;
  retentionDays: number;
  oldestEventDate: string;
}

// ─── Indexer types ────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  'PaymentInitiated',
  'PaymentCompleted',
  'SettlementTriggered',
  'FXExecuted',
  'BillPaid',
  'AnchorSettled'
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface IndexedEvent {
  id: string;
  stellarId?: string | null;
  contractId: string;
  topics: string[];
  type: EventType;
  rawValue: string;
  decodedPayload?: unknown;
  ledger: number;
  indexedAt: string;
}
