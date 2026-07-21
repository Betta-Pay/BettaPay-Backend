import { z } from 'zod';
import { CurrencyCode } from './currency.js';
import { validateStellarAddress } from '@bettapay/stellar-utils';

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
  challenge: z.string().min(1),
  signature: z.string().min(1)
});
export type WalletVerifyBody = z.infer<typeof WalletVerifyBody>;

export const merchantSchema = z.object({
  id: idSchema,
  name: z.string(),
  ownerId: StellarAddressSchema,
  createdAt: isoDateString,
  deletedAt: isoDateString.optional(),
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
});

export const fxQuoteSchema = z.object({
  id: idSchema,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: z.string(),
  expiresAt: isoDateString
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
export type AmountString = z.infer<typeof AmountString>;
export type PositiveAmountString = z.infer<typeof PositiveAmountString>;

// Convenience parsers
export function parseEvent(raw: unknown) {
  return eventSchemas.parse(raw);
}

export function safeParseEvent(raw: unknown) {
  return eventSchemas.safeParse(raw);
}

// ─── Webhook URL validation ───────────────────────────────────────────────────

const PRIVATE_HOST_PATTERN =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|::1|\[::1\]|0\.0\.0\.0)$/i;

function isPrivateOrLocalhost(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);
    return PRIVATE_HOST_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

export const WebhookUrlSchema = z
  .string()
  .url('Webhook URL must be a valid URL')
  .max(2048, 'Webhook URL must not exceed 2048 characters')
  .refine(
    (url) => process.env.NODE_ENV !== 'production' || url.startsWith('https://'),
    'Webhook URL must use HTTPS in production'
  )
  .refine(
    (url) => process.env.NODE_ENV !== 'production' || !isPrivateOrLocalhost(url),
    'Webhook URL must not point to localhost or private IP addresses'
  );

export type WebhookUrl = z.infer<typeof WebhookUrlSchema>;

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
  webhookUrl: z.string().url().optional(),
  preferredAsset: z.string().optional(),
  autoSettle: z.boolean().optional(),
  maxSettlementAmount: z.number().positive().optional(),
  minSettlementAmount: z.number().positive().optional(),
  dailySettlementLimit: z.number().positive().optional(),
});

export type MerchantSettings = z.infer<typeof MerchantSettings>;

export const CreateMerchantBody = z.object({
  id: z.string().min(1, 'id is required'),
  name: z.string().min(1, 'name is required'),
  ownerId: StellarAddressSchema, // validated Stellar public key
  settings: MerchantSettings.optional(),
  secret: z.string().optional(),
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
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a numeric string').optional(),
  asset: CurrencyCode.optional(),
  items: z.array(z.object({
    amount: z.string().regex(/^\d+(\.\d+)?$/, 'amount must be a numeric string'),
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

export const AuthTokenBody = z.object({
  merchantId: StellarAddressSchema,
  secret: z.string().min(1, 'secret is required'),
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

// Per-merchant fee rule configuration. feeBps is basis points (1% = 100 bps),
// capped at 10000 (100%). Unknown keys are stripped; the route merges these into
// the merchant's existing settings rather than replacing them.
export const UpdateMerchantSettingsBody = z.object({
  feeBps: z.number().int().min(0).max(10000).optional(),
  tier: z.string().optional(),
  minSettlementAmount: z.string().regex(/^\d+(\.\d+)?$/, 'minSettlementAmount must be a numeric string').optional(),
  maxSettlementAmount: z.string().regex(/^\d+(\.\d+)?$/, 'maxSettlementAmount must be a numeric string').optional(),
  dailySettlementLimit: z.string().regex(/^\d+(\.\d+)?$/, 'dailySettlementLimit must be a numeric string').optional(),
  webhookUrl: WebhookUrlSchema.optional(),
});

export const UpdateMerchantNameBody = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters')
});
export type UpdateMerchantNameBody = z.infer<typeof UpdateMerchantNameBody>;

export const PaginationQuery = z.object({
  limit: z.coerce.number().max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export const SettlementListQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
}).refine(
  (data) => !data.from || !data.to || data.from <= data.to,
  { message: 'from must be before to' }
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
export type AuthTokenBody = z.infer<typeof AuthTokenBody>;
export type UpdatePaymentStatusBody = z.infer<typeof UpdatePaymentStatusBody>;
export type UpdateMerchantSettingsBody = z.infer<typeof UpdateMerchantSettingsBody>;

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
