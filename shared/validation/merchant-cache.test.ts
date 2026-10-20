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
