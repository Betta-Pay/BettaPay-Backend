/**
 * merchant-cache-smoke.test.ts
 *
 * Smoke test verifying that MerchantCache resolves through @bettapay/validation
 * and performs cache reads in settlement-engine.
 */

import test from 'tape';
import { MerchantCache, getCachedMerchant } from '@bettapay/validation';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('merchant-cache smoke test: MerchantCache exports from @bettapay/validation and performs reads', async (t) => {
  const cache = new MerchantCache();

  t.equal(typeof MerchantCache, 'function', 'MerchantCache class should be exported by @bettapay/validation');
  t.equal(typeof getCachedMerchant, 'function', 'getCachedMerchant should be exported by @bettapay/validation');

  const merchantId = 'merch_smoke_test_123';
  const mockMerchant = {
    id: merchantId,
    name: 'Acme Corp',
    feeBps: 100,
    status: 'active',
  };

  cache.set(merchantId, mockMerchant as any);

  const cached = cache.get(merchantId);
  t.ok(cached, 'cache.get should retrieve cached merchant');
  t.equal(cached?.id, merchantId, 'cached merchant ID should match');
  t.equal((cached as any)?.name, 'Acme Corp', 'cached merchant name should match');

  // Test getCachedMerchant helper with cache fallback function
  let dbCallCount = 0;
  const fetchFromDb = async (id: string) => {
    dbCallCount++;
    return mockMerchant;
  };

  const result1 = await getCachedMerchant(merchantId, cache, fetchFromDb);
  t.equal(result1?.id, merchantId, 'getCachedMerchant returns cached merchant');
  t.equal(dbCallCount, 0, 'db fetch should not be called on cache hit');

  const newId = 'merch_smoke_test_456';
  const result2 = await getCachedMerchant(newId, cache, fetchFromDb);
  t.equal(dbCallCount, 1, 'db fetch should be called on cache miss');
  t.equal(result2?.id, merchantId, 'db result returned');

  t.end();
});

test('merchant-cache smoke test: settlement-engine index.ts has clean import from @bettapay/validation', (t) => {
  const indexPath = path.join(__dirname, 'index.ts');
  const indexContent = fs.readFileSync(indexPath, 'utf8');

  // Verify no broken relative imports or stray tokens exist
  t.notOk(indexContent.includes('shared/validation/merchant-cache'), 'should not contain relative merchant-cache import');
  t.notOk(indexContent.includes('cache.js'), 'should not contain stray cache.js token');
  t.notOk(indexContent.includes('upstream/main'), 'should not contain stray upstream/main token');

  // Verify import is from @bettapay/validation
  t.ok(indexContent.includes('MerchantCache'), 'should import MerchantCache');
  t.ok(indexContent.includes('getCachedMerchant'), 'should import getCachedMerchant');
  t.ok(indexContent.includes('@bettapay/validation'), 'should import from @bettapay/validation');

  t.end();
});
