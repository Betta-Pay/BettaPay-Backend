/**
 * merchant-cache.test.ts
 *
 * Cache-hit / cache-miss behaviour for getCachedMerchant (#822).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MerchantCache, getCachedMerchant } from './merchant-cache.js';

test('getCachedMerchant: cache miss invokes the loader exactly once', async () => {
  const cache = new MerchantCache<{ id: string; name: string }>();
  let loaderCalls = 0;
  const merchant = { id: 'm-1', name: 'Acme' };

  const result = await getCachedMerchant('m-1', cache, async (id) => {
    loaderCalls += 1;
    assert.equal(id, 'm-1');
    return merchant;
  });

  assert.deepEqual(result, merchant);
  assert.equal(loaderCalls, 1, 'loader must run exactly once on a miss');
  assert.equal(cache.size, 1, 'miss should populate the cache');
});

test('getCachedMerchant: cache hit does not invoke the loader', async () => {
  const cache = new MerchantCache<{ id: string; name: string }>();
  const merchant = { id: 'm-2', name: 'Beta' };
  cache.set('m-2', merchant);

  let loaderCalls = 0;
  const result = await getCachedMerchant('m-2', cache, async () => {
    loaderCalls += 1;
    return { id: 'm-2', name: 'should-not-load' };
  });

  assert.deepEqual(result, merchant);
  assert.equal(loaderCalls, 0, 'loader must not run on a hit');
});

test('getCachedMerchant: null loader result is not cached and returns null', async () => {
  const cache = new MerchantCache<{ id: string }>();
  let loaderCalls = 0;

  const first = await getCachedMerchant('missing', cache, async () => {
    loaderCalls += 1;
    return null;
  });
  const second = await getCachedMerchant('missing', cache, async () => {
    loaderCalls += 1;
    return null;
  });

  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(loaderCalls, 2, 'null results must not be cached');
  assert.equal(cache.size, 0);
});

test('MerchantCache: enforces maxEntries cap and evicts oldest entries (FIFO/LRU)', () => {
  const cache = new MerchantCache<string>(30_000, 3);
  assert.equal(cache.maxEntries, 3);

  cache.set('m-1', 'alpha');
  cache.set('m-2', 'beta');
  cache.set('m-3', 'gamma');
  assert.equal(cache.size, 3);

  // Inserting 4th item when max is 3 should evict the oldest entry ('m-1')
  cache.set('m-4', 'delta');
  assert.equal(cache.size, 3, 'cache size must not exceed maxEntries');
  assert.equal(cache.get('m-1'), undefined, 'oldest entry m-1 should be evicted');
  assert.equal(cache.get('m-2'), 'beta');
  assert.equal(cache.get('m-3'), 'gamma');
  assert.equal(cache.get('m-4'), 'delta');
});

test('MerchantCache: get() refreshes LRU recency to avoid eviction', () => {
  const cache = new MerchantCache<string>({ ttlMs: 30_000, maxEntries: 3 });

  cache.set('m-1', 'alpha');
  cache.set('m-2', 'beta');
  cache.set('m-3', 'gamma');

  // Access m-1 to refresh its recency
  assert.equal(cache.get('m-1'), 'alpha');

  // Now inserting m-4 should evict m-2 (least recently used), not m-1
  cache.set('m-4', 'delta');
  assert.equal(cache.size, 3);
  assert.equal(cache.get('m-2'), undefined, 'LRU entry m-2 should be evicted');
  assert.equal(cache.get('m-1'), 'alpha', 'recently accessed m-1 should remain cached');
  assert.equal(cache.get('m-3'), 'gamma');
  assert.equal(cache.get('m-4'), 'delta');
});

test('MerchantCache: re-setting existing key updates value and recency without exceeding cap', () => {
  const cache = new MerchantCache<string>(30_000, 2);

  cache.set('m-1', 'initial');
  cache.set('m-2', 'beta');
  assert.equal(cache.size, 2);

  // Update m-1
  cache.set('m-1', 'updated');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('m-1'), 'updated');

  // Insert m-3 -> m-2 was least recently updated/accessed, so m-2 is evicted
  cache.set('m-3', 'gamma');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('m-2'), undefined);
  assert.equal(cache.get('m-1'), 'updated');
  assert.equal(cache.get('m-3'), 'gamma');
});
