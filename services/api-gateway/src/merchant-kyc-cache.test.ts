import test from 'tape';
import { createTestApp, generateTestJwt } from './test-utils.js';
import { merchantCache } from './index.js';
import { getCachedMerchant, MerchantCache } from '@bettapay/validation';

const SERVICE_SECRET = process.env.INTER_SERVICE_SECRET || 'dev-inter-service-secret';

test('merchantCache is invalidated when PATCH /api/admin/merchants/:id/kyc updates KYC status', async (t) => {
  const customCache = new MerchantCache();
  const initialMerchant = {
    id: 'merch_kyc_test_1',
    name: 'KYC Test Merchant',
    ownerId: 'owner_kyc_1',
    kycStatus: 'unverified',
    status: 'active',
    deletedAt: null,
    settings: {},
  };

  const { app, mockPrisma } = await createTestApp(
    { merchantCache: customCache },
    { merchants: [initialMerchant] },
  );

  // Pre-populate cache with the old KYC status (as downstream read-through would do)
  customCache.set('merch_kyc_test_1', initialMerchant);
  t.equal(customCache.get('merch_kyc_test_1')?.kycStatus, 'unverified', 'pre-condition: cache holds stale unverified status');

  // Trigger KYC update via PATCH /api/admin/merchants/:id/kyc
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/admin/merchants/merch_kyc_test_1/kyc',
    headers: {
      'x-service-token': SERVICE_SECRET,
      'x-csrf-check': '1',
    },
    payload: { kycStatus: 'verified' },
  });

  t.equal(res.statusCode, 200, 'KYC update returns 200');
  const body = JSON.parse(res.body);
  t.equal(body.data.merchant.kycStatus, 'verified', 'response has updated KYC status');

  // Cache entry must have been invalidated (deleted)
  t.equal(customCache.get('merch_kyc_test_1'), undefined, 'merchantCache entry is invalidated on KYC update');

  // Subsequent read via getCachedMerchant reflects the updated KYC status immediately
  const refreshed = await getCachedMerchant(
    'merch_kyc_test_1',
    customCache,
    (id) => mockPrisma.merchant.findUnique({ where: { id } }),
  );
  t.equal(refreshed?.kycStatus, 'verified', 'subsequent read reflects updated KYC status immediately');

  await app.close();
  t.end();
});

test('global merchantCache is invalidated on KYC update when using default cache', async (t) => {
  const merchantId = 'merch_kyc_global_test';
  const initialMerchant = {
    id: merchantId,
    name: 'Global KYC Test Merchant',
    ownerId: 'owner_kyc_2',
    kycStatus: 'pending',
    status: 'active',
    deletedAt: null,
    settings: {},
  };

  const { app, mockPrisma } = await createTestApp(
    {},
    { merchants: [initialMerchant] },
  );

  // Pre-populate global merchantCache
  merchantCache.set(merchantId, initialMerchant);
  t.equal(merchantCache.get(merchantId)?.kycStatus, 'pending', 'cache holds pending status');

  // Trigger KYC update
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/admin/merchants/${merchantId}/kyc`,
    headers: {
      'x-service-token': SERVICE_SECRET,
      'x-csrf-check': '1',
    },
    payload: { kycStatus: 'verified' },
  });

  t.equal(res.statusCode, 200, 'returns 200');
  t.equal(merchantCache.get(merchantId), undefined, 'global merchantCache invalidated');

  // Subsequent read reflects updated status immediately
  const fresh = await getCachedMerchant(
    merchantId,
    merchantCache,
    (id) => mockPrisma.merchant.findUnique({ where: { id } }),
  );
  t.equal(fresh?.kycStatus, 'verified', 'subsequent read immediately reflects verified status');

  await app.close();
  t.end();
});
