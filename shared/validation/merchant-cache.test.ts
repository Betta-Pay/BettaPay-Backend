import test from 'node:test';
import assert from 'node:assert';
import { MerchantCache, getCachedMerchant } from './merchant-cache.js';
import {
  MerchantCache as ExportedMerchantCache,
  getCachedMerchant as exportedGetCachedMerchant,
} from './index.js';

interface TestMerchant {
  id: string;
  name: string;
  version: number;
}

test('merchant-cache exports are re-exported by package index', () => {
  assert.strictEqual(ExportedMerchantCache, MerchantCache);
  assert.strictEqual(exportedGetCachedMerchant, getCachedMerchant);
});

test('MerchantCache primitives: get, set, invalidate, clear, size', () => {
  const cache = new MerchantCache<TestMerchant>();
  assert.strictEqual(cache.size, 0);

  const m1: TestMerchant = { id: 'm1', name: 'Merchant One', version: 1 };
  const m2: TestMerchant = { id: 'm2', name: 'Merchant Two', version: 1 };

  cache.set('m1', m1);
  assert.strictEqual(cache.size, 1);
  assert.deepStrictEqual(cache.get('m1'), m1);

  cache.set('m2', m2);
  assert.strictEqual(cache.size, 2);
  assert.deepStrictEqual(cache.get('m2'), m2);

  // Invalidate specific key
  cache.invalidate('m1');
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.get('m1'), undefined);
  assert.deepStrictEqual(cache.get('m2'), m2);

  // Invalidate non-existent key is a safe no-op
  cache.invalidate('non-existent');
  assert.strictEqual(cache.size, 1);

  // Clear removes all keys
  cache.clear();
  assert.strictEqual(cache.size, 0);
  assert.strictEqual(cache.get('m2'), undefined);
});

test('MerchantCache: evicts entries past TTL', async () => {
  const cache = new MerchantCache<TestMerchant>(15); // 15ms TTL
  const m1: TestMerchant = { id: 'm1', name: 'Expiring', version: 1 };

  cache.set('m1', m1);
  assert.deepStrictEqual(cache.get('m1'), m1);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(cache.get('m1'), undefined, 'Entry must be evicted after TTL expires');
});

test('getCachedMerchant: cache-miss then populate path', async () => {
  const cache = new MerchantCache<TestMerchant>();
  let loaderCalls = 0;

  const loader = async (id: string): Promise<TestMerchant | null> => {
    loaderCalls += 1;
    return { id, name: `Merchant ${id}`, version: 1 };
  };

  // First read: cache miss, invokes loader
  const first = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 1, 'loader must be called exactly once on cache miss');
  assert.deepStrictEqual(first, { id: 'm1', name: 'Merchant m1', version: 1 });
  assert.strictEqual(cache.size, 1);

  // Second read: cache hit, loader NOT called
  const second = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 1, 'loader must NOT be called on cache hit');
  assert.deepStrictEqual(second, first);

  // Third read: still cached
  const third = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 1, 'loader count must remain 1');
  assert.deepStrictEqual(third, first);
});

test('getCachedMerchant: null loader response is not cached', async () => {
  const cache = new MerchantCache<TestMerchant>();
  let loaderCalls = 0;

  const loader = async (_id: string): Promise<TestMerchant | null> => {
    loaderCalls += 1;
    return null;
  };

  const first = await getCachedMerchant('missing', cache, loader);
  assert.strictEqual(first, null);
  assert.strictEqual(loaderCalls, 1);
  assert.strictEqual(cache.size, 0, 'null results should not populate cache');

  const second = await getCachedMerchant('missing', cache, loader);
  assert.strictEqual(second, null);
  assert.strictEqual(loaderCalls, 2, 'subsequent read after null invokes loader again');
});

test('getCachedMerchant: invalidation forces the next read to reload from loader', async () => {
  const cache = new MerchantCache<TestMerchant>();
  let loaderCalls = 0;
  let currentVersion = 1;

  const loader = async (id: string): Promise<TestMerchant | null> => {
    loaderCalls += 1;
    return { id, name: `Merchant ${id}`, version: currentVersion };
  };

  // Populate cache with v1
  const v1 = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 1);
  assert.strictEqual(v1?.version, 1);

  // Subsequent read hits cache
  const cachedV1 = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 1);
  assert.strictEqual(cachedV1?.version, 1);

  // Merchant updates in database and cache is invalidated
  currentVersion = 2;
  cache.invalidate('m1');
  assert.strictEqual(cache.get('m1'), undefined, 'invalidated key is immediately gone from cache');

  // Next read forces reload from loader
  const v2 = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 2, 'loader must be invoked again after invalidation');
  assert.strictEqual(v2?.version, 2, 'reloaded merchant reflects updated data');

  // Further read hits cache with v2
  const cachedV2 = await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 2, 'loader count stays at 2 for cached v2');
  assert.strictEqual(cachedV2?.version, 2);
});

test('getCachedMerchant: per-merchant isolation and exact loader call counts', async () => {
  const cache = new MerchantCache<TestMerchant>();
  const callCounts: Record<string, number> = { m1: 0, m2: 0, m3: 0 };

  const loader = async (id: string): Promise<TestMerchant | null> => {
    callCounts[id] = (callCounts[id] || 0) + 1;
    return { id, name: `Merchant ${id}`, version: 1 };
  };

  // Sequential reads across different merchants
  await getCachedMerchant('m1', cache, loader);
  await getCachedMerchant('m1', cache, loader);
  await getCachedMerchant('m2', cache, loader);
  await getCachedMerchant('m3', cache, loader);
  await getCachedMerchant('m3', cache, loader);
  await getCachedMerchant('m3', cache, loader);

  assert.strictEqual(callCounts.m1, 1, 'm1 called once');
  assert.strictEqual(callCounts.m2, 1, 'm2 called once');
  assert.strictEqual(callCounts.m3, 1, 'm3 called once');
  assert.strictEqual(cache.size, 3);

  // Invalidate only m2
  cache.invalidate('m2');
  assert.strictEqual(cache.size, 2);

  // Reading m1 and m3 does not call loader
  await getCachedMerchant('m1', cache, loader);
  await getCachedMerchant('m3', cache, loader);
  assert.strictEqual(callCounts.m1, 1);
  assert.strictEqual(callCounts.m3, 1);

  // Reading m2 invokes loader for m2 only
  await getCachedMerchant('m2', cache, loader);
  assert.strictEqual(callCounts.m2, 2, 'm2 called a second time after invalidation');
  assert.strictEqual(callCounts.m1, 1);
  assert.strictEqual(callCounts.m3, 1);
});

test('getCachedMerchant: concurrent readers racing with invalidation do not receive indefinitely stale data', async () => {
  const cache = new MerchantCache<TestMerchant>();
  let loaderCalls = 0;
  let currentVersion = 1;

  const loader = async (id: string): Promise<TestMerchant | null> => {
    loaderCalls += 1;
    // Add small async yield to simulate real DB I/O
    await new Promise((resolve) => setImmediate(resolve));
    return { id, name: `Merchant ${id}`, version: currentVersion };
  };

  // Seed cache with v1
  await getCachedMerchant('m1', cache, loader);
  assert.strictEqual(loaderCalls, 1);

  // Fire 10 concurrent reads against cached v1
  const initialConcurrentReads = await Promise.all(
    Array.from({ length: 10 }, () => getCachedMerchant('m1', cache, loader)),
  );
  assert.strictEqual(loaderCalls, 1, 'all 10 concurrent reads must hit cache without calling loader');
  for (const result of initialConcurrentReads) {
    assert.strictEqual(result?.version, 1);
  }

  // Invalidate cache and update version in "database"
  currentVersion = 2;
  cache.invalidate('m1');

  // Next batch of concurrent readers race after invalidation
  const postInvalidationReads = await Promise.all(
    Array.from({ length: 5 }, () => getCachedMerchant('m1', cache, loader)),
  );

  // None of the post-invalidation readers should receive stale v1 data
  for (const result of postInvalidationReads) {
    assert.strictEqual(
      result?.version,
      2,
      'Concurrent readers after invalidation must receive fresh v2 data, never stale v1',
    );
  }

  // Once populated with v2, subsequent reads hit cache
  const callsAfterRepopulation = loaderCalls;
  const subsequentReads = await Promise.all(
    Array.from({ length: 5 }, () => getCachedMerchant('m1', cache, loader)),
  );
  assert.strictEqual(loaderCalls, callsAfterRepopulation, 'No additional loader calls once repopulated');
  for (const result of subsequentReads) {
    assert.strictEqual(result?.version, 2);
  }
});
