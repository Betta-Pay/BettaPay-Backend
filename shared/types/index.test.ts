import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaginationMeta } from './index.js';

test('buildPaginationMeta clamps invalid limits and preserves its exact shape', () => {
  for (const [limit, expected] of [[-10, 1], [0, 1], [2.9, 2]] as const) {
    const result = buildPaginationMeta(1, limit, 5);
    assert.deepEqual(Object.keys(result).sort(), [
      'page', 'limit', 'total', 'totalPages', 'hasNext', 'hasPrev',
    ].sort());
    assert.equal(result.limit, expected);
  }
});

test('buildPaginationMeta computes boundary metadata for empty, full, and partial pages', () => {
  assert.deepEqual(buildPaginationMeta(1, 10, 0), {
    page: 1, limit: 10, total: 0, totalPages: 0, hasNext: false, hasPrev: false,
  });
  assert.deepEqual(buildPaginationMeta(1, 10, 20), {
    page: 1, limit: 10, total: 20, totalPages: 2, hasNext: true, hasPrev: false,
  });
  assert.deepEqual(buildPaginationMeta(2, 10, 20), {
    page: 2, limit: 10, total: 20, totalPages: 2, hasNext: false, hasPrev: true,
  });
  assert.deepEqual(buildPaginationMeta(2, 10, 21), {
    page: 2, limit: 10, total: 21, totalPages: 3, hasNext: true, hasPrev: true,
  });
});