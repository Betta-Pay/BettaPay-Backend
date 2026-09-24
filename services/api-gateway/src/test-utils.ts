import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { buildApp, AppOptions } from './index.js';
import type {
  SettlementClient,
  SettlementClientResult,
} from './clients/settlement-client.js';
import type {
  FxClient,
  FxQuoteRequest,
  FxQuoteResponse,
} from './clients/fx-client.js';
import type { IndexerClient, IndexerEvent } from './clients/indexer-client.js';

// ── Mock downstream-client builders ─────────────────────────────────────────
// Single source of truth for the settlement / fx / indexer client mocks used
// across the API gateway test suite (issue #557). Tests override individual
// methods via the `overrides` argument; defaults are stable and consistent so
// fixture drift between test files is impossible.

const MOCK_QUOTE: FxQuoteResponse = {
  quoteId: 'quote_mock_1',
  from: 'USDC',
  to: 'NGN',
  amount: '10.00',
  result: '15455.0000',
  rate: '1545.50000000',
  slippageBps: 50,
  slippageLimit: '0.0050',
  cachedAt: '2026-07-28T10:00:00.000Z',
  expiresAt: '2026-07-28T10:01:00.000Z',
};

export function createMockSettlementClient(
  overrides: Partial<SettlementClient> = {}
): SettlementClient {
  return {
    createSettlement: async (
      payload: unknown
    ): Promise<SettlementClientResult> => {
      const data = (payload ?? {}) as Record<string, unknown>;
      return {
        status: 201,
        body: {
          data: {
            id: 'set_mock_1',
            merchantId: (data.merchantId as string) ?? 'merch_1',
            grossAmount: (data.grossAmount as string) ?? '0.00',
            feeAmount: '0.00',
            netAmount: (data.grossAmount as string) ?? '0.00',
            asset: (data.asset as string) ?? 'USDC',
            status: 'pending',
            createdAt: new Date().toISOString(),
          },
        },
        contentType: 'application/json',
      };
    },
    ...overrides,
  };
}

export function createMockFxClient(
  overrides: Partial<FxClient> = {}
): FxClient {
  return {
    getQuote: async (request: FxQuoteRequest): Promise<FxQuoteResponse> => ({
      ...MOCK_QUOTE,
      from: request.from,
      to: request.to,
      amount: request.amount,
    }),
    ...overrides,
  };
}

export function createMockIndexerClient(
  overrides: Partial<IndexerClient> = {}
): IndexerClient {
  return {
    getPaymentEvents: async (): Promise<IndexerEvent[]> => [],
    testWebhook: async () => ({ success: true, statusCode: 200 }),
    ...overrides,
  };
}

export interface MockData {
  payments?: any[];
  merchants?: any[];
  settlements?: any[];
  auditLogs?: any[];
  supportedAssets?: any[];
}

export function createMockPrisma(initialData: MockData = {}) {
  const store = {
    payments: [...(initialData.payments || [])],
    merchants: [...(initialData.merchants || [])],
    settlements: [...(initialData.settlements || [])],
    auditLogs: [...(initialData.auditLogs || [])],
    supportedAssets: [...(initialData.supportedAssets || [])],
  };

  function filterPayments(where: any = {}) {
    return store.payments.filter((p) => {
      if (where?.merchantId && p.merchantId !== where.merchantId) return false;
      if (where?.status && p.status !== where.status) return false;
      if (where?.createdAt?.gte && new Date(p.createdAt) < new Date(where.createdAt.gte)) return false;
      if (where?.createdAt?.lte && new Date(p.createdAt) > new Date(where.createdAt.lte)) return false;
      return true;
    });
  }

  const mockPayment = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      return store.payments.find((p) => p.id === where.id) || null;
    },
    findFirst: async ({ where }: { where: any }) => {
      return (
        store.payments.find((p) => {
          if (where.id && p.id !== where.id) return false;
          if (where.idempotencyKey && p.idempotencyKey !== where.idempotencyKey) return false;
          if (where.idempotencyKeyExpiresAt?.gt && p.idempotencyKeyExpiresAt && new Date(p.idempotencyKeyExpiresAt) <= where.idempotencyKeyExpiresAt.gt) return false;
          return true;
        }) || null
      );
    },
    findMany: async ({ where, take, skip }: { where?: any; take?: number; skip?: number } = {}) => {
      const result = filterPayments(where).sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      const start = skip || 0;
      const end = take !== undefined ? start + take : undefined;
      return result.slice(start, end);
    },
    count: async ({ where }: { where?: any } = {}) => {
      return filterPayments(where).length;
    },
    create: async ({ data }: { data: any }) => {
      const created = {
        id: data.id || 'pay_' + Math.random().toString(36).substring(2, 9),
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'initiated',
        ...data,
      };
      store.payments.push(created);
      return created;
    },
    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const index = store.payments.findIndex((p) => p.id === where.id);
      if (index === -1) {
        throw new Error(`Record to update not found: payment ${where.id}`);
      }
      const updated = {
        ...store.payments[index],
        ...data,
        updatedAt: new Date(),
      };
      store.payments[index] = updated;
      return updated;
    },
  };

  const mockMerchant = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      return store.merchants.find((m) => m.id === where.id) || null;
    },
    findFirst: async ({ where }: { where: any }) => {
      return (
        store.merchants.find((m) => {
          if (where.id && m.id !== where.id) return false;
          if (where.deletedAt === null && m.deletedAt !== null && m.deletedAt !== undefined) return false;
          return true;
        }) || null
      );
    },
    findMany: async ({ where }: { where?: any } = {}) => {
      return [...store.merchants];
    },
    create: async ({ data }: { data: any }) => {
      const created = {
        id: data.id || 'm_' + Math.random().toString(36).substring(2, 9),
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        status: 'active',
        settings: {},
        ...data,
      };
      store.merchants.push(created);
      return created;
    },
    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const index = store.merchants.findIndex((m) => m.id === where.id);
      if (index === -1) {
        throw new Error(`Record to update not found: merchant ${where.id}`);
      }
      const updated = {
        ...store.merchants[index],
        ...data,
        updatedAt: new Date(),
      };
      store.merchants[index] = updated;
      return updated;
    },
  };

  function filterSettlements(where: any = {}) {
    let result = [...store.settlements];
    if (where?.merchantId) {
      result = result.filter((s) => s.merchantId === where.merchantId);
    }
    if (where?.status) {
      result = result.filter((s) => s.status === where.status);
    }
    if (where?.initiatedAt?.gte) {
      const gte = new Date(where.initiatedAt.gte);
      result = result.filter((s) => new Date(s.initiatedAt) >= gte);
    }
    if (where?.initiatedAt?.lte) {
      const lte = new Date(where.initiatedAt.lte);
      result = result.filter((s) => new Date(s.initiatedAt) <= lte);
    }
    return result;
  }

  const mockSettlement = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      return store.settlements.find((s) => s.id === where.id) || null;
    },
    findFirst: async ({ where }: { where: any }) => {
      return store.settlements.find((s) => s.id === where.id) || null;
    },
    findMany: async ({ where, take, skip }: { where?: any; take?: number; skip?: number } = {}) => {
      const result = filterSettlements(where).sort(
        (a, b) => new Date(b.initiatedAt).getTime() - new Date(a.initiatedAt).getTime()
      );
      const start = skip || 0;
      const end = take !== undefined ? start + take : undefined;
      return result.slice(start, end);
    },
    count: async ({ where }: { where?: any } = {}) => {
      return filterSettlements(where).length;
    },
    create: async ({ data }: { data: any }) => {
      const created = {
        id: data.id || 'set_' + Math.random().toString(36).substring(2, 9),
        initiatedAt: new Date(),
        status: 'PENDING',
        completedAt: null,
        ...data,
      };
      store.settlements.push(created);
      return created;
    },
    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const index = store.settlements.findIndex((s) => s.id === where.id);
      if (index === -1) {
        throw new Error(`Record to update not found: settlement ${where.id}`);
      }
      const updated = {
        ...store.settlements[index],
        ...data,
      };
      store.settlements[index] = updated;
      return updated;
    },
  };

  const mockAuditLog = {
    findMany: async ({ where, take, skip }: { where?: any; take?: number; skip?: number } = {}) => {
      let result = [...store.auditLogs];
      if (where?.entityType) result = result.filter((a) => a.entityType === where.entityType);
      if (where?.action) result = result.filter((a) => a.action === where.action);
      const start = skip || 0;
      const end = take ? start + take : undefined;
      return result.slice(start, end);
    },
    count: async ({ where }: { where?: any } = {}) => {
      let result = [...store.auditLogs];
      if (where?.entityType) result = result.filter((a) => a.entityType === where.entityType);
      if (where?.action) result = result.filter((a) => a.action === where.action);
      return result.length;
    },
    create: async ({ data }: { data: any }) => {
      const created = { id: 'audit_' + Math.random().toString(36).substring(2, 9), createdAt: new Date(), ...data };
      store.auditLogs.push(created);
      return created;
    },
  };

  const mockSupportedAsset = {
    findUnique: async ({ where }: { where: { code: string } }) => {
      return store.supportedAssets.find((a) => a.code === where.code) || null;
    },
    findMany: async ({ where }: { where?: any } = {}) => {
      let result = [...store.supportedAssets];
      if (where?.isActive !== undefined) {
        result = result.filter((a) => a.isActive === where.isActive);
      }
      return result;
    },
    create: async ({ data }: { data: any }) => {
      const created = { ...data };
      store.supportedAssets.push(created);
      return created;
    },
    update: async ({ where, data }: { where: { code: string }; data: any }) => {
      const index = store.supportedAssets.findIndex((a) => a.code === where.code);
      if (index === -1) {
        throw new Error(`Record to update not found: supportedAsset ${where.code}`);
      }
      const updated = { ...store.supportedAssets[index], ...data };
      store.supportedAssets[index] = updated;
      return updated;
    },
    delete: async ({ where }: { where: { code: string } }) => {
      const index = store.supportedAssets.findIndex((a) => a.code === where.code);
      if (index === -1) {
        throw new Error(`Record to delete not found: supportedAsset ${where.code}`);
      }
      const [deleted] = store.supportedAssets.splice(index, 1);
      return deleted;
    },
  };

  const mockPrismaInstance = {
    store,
    payment: mockPayment,
    merchant: mockMerchant,
    settlement: mockSettlement,
    auditLog: mockAuditLog,
    supportedAsset: mockSupportedAsset,
    $transaction: async (cb: (tx: any) => Promise<any>) => {
      return cb(mockPrismaInstance);
    },
    $queryRaw: async () => [{ '?column?': 1 }],
    $connect: async () => {},
    $disconnect: async () => {},
  };

  return mockPrismaInstance;
}

export function generateTestJwt(
  app: FastifyInstance,
  payload: object = { merchantId: 'm1', ownerId: 'u1' }
): string {
  return app.jwt.sign(payload);
}

export async function createTestApp(
  overrides: Partial<AppOptions> = {},
  initialData: MockData = {}
) {
  const mockPrisma = overrides.prisma || (createMockPrisma(initialData) as any);
  const app = buildApp({
    prisma: mockPrisma,
    settlementClient: createMockSettlementClient() as any,
    fxClient: createMockFxClient() as any,
    indexerClient: createMockIndexerClient() as any,
    logger: false,
    ...overrides,
  });
  // Boot the app so decorated helpers (app.jwt) and route schemas are ready
  // before tests call generateTestJwt / inject.
  await app.ready();
  return { app, mockPrisma };
}
