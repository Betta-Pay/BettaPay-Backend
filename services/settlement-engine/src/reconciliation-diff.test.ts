/**
 * reconciliation-diff.test.ts
 *
 * Unit tests covering reconciliation diff sets (matchedIds and mismatched):
 * - Empty reconciliation returns zero matched and zero mismatched entries.
 * - All-match fixture reports every row as matched.
 * - All-mismatch fixture reports every row as mismatched.
 * - Mixed fixture exercises the mismatch branch and verifies field diffs.
 */

import test from 'tape';
import {
  computeReconciliationDiff,
  type ReconcileRecordLike,
} from './settlement-amounts.js';

test('reconciliation diff: empty reconciliation returns zero matched and zero mismatched entries', (t) => {
  const local: ReconcileRecordLike[] = [];
  const gateway: ReconcileRecordLike[] = [];

  const { matchedIds, mismatched } = computeReconciliationDiff(local, gateway);

  t.equal(matchedIds.size, 0, 'empty reconciliation has 0 matched IDs');
  t.equal(mismatched.length, 0, 'empty reconciliation has 0 mismatched entries');
  t.end();
});

test('reconciliation diff: all-match fixture reports every row as matched', (t) => {
  const local: ReconcileRecordLike[] = [
    { id: 'set_1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00' },
    { id: 'set_2', grossAmount: '250.50', feeAmount: '2.50', netAmount: '248.00' },
    { id: 'set_3', totalAmount: '50.00', feeAmount: '0.50', netAmount: '49.50' },
  ];

  const gateway: ReconcileRecordLike[] = [
    { id: 'set_1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00' },
    { id: 'set_2', grossAmount: '250.50', feeAmount: '2.50', netAmount: '248.00' },
    { id: 'set_3', grossAmount: '50.00', feeAmount: '0.50', netAmount: '49.50' },
  ];

  const { matchedIds, mismatched } = computeReconciliationDiff(local, gateway);

  t.equal(matchedIds.size, 3, 'all 3 rows should be reported as matched');
  t.ok(matchedIds.has('set_1'), 'set_1 should be in matchedIds');
  t.ok(matchedIds.has('set_2'), 'set_2 should be in matchedIds');
  t.ok(matchedIds.has('set_3'), 'set_3 should be in matchedIds');
  t.equal(mismatched.length, 0, '0 rows should be reported as mismatched');
  t.end();
});

test('reconciliation diff: all-mismatch fixture reports every row as mismatched', (t) => {
  const local: ReconcileRecordLike[] = [
    { id: 'set_1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00' },
    { id: 'set_2', grossAmount: '200.00', feeAmount: '2.00', netAmount: '198.00' },
  ];

  const gateway: ReconcileRecordLike[] = [
    { id: 'set_1', grossAmount: '105.00', feeAmount: '1.00', netAmount: '104.00' }, // gross mismatch
    { id: 'set_2', grossAmount: '200.00', feeAmount: '3.00', netAmount: '197.00' }, // fee mismatch
  ];

  const { matchedIds, mismatched } = computeReconciliationDiff(local, gateway);

  t.equal(matchedIds.size, 0, '0 rows should be reported as matched in all-mismatch fixture');
  t.equal(mismatched.length, 2, 'every row should be reported as mismatched');
  t.equal(mismatched[0].id, 'set_1', 'first mismatch should be set_1');
  t.ok(mismatched[0].diffs.includes('grossAmount'), 'set_1 diff should flag grossAmount');
  t.ok(mismatched[0].diffs.includes('netAmount'), 'set_1 diff should flag netAmount');
  t.equal(mismatched[1].id, 'set_2', 'second mismatch should be set_2');
  t.ok(mismatched[1].diffs.includes('feeAmount'), 'set_2 diff should flag feeAmount');
  t.ok(mismatched[1].diffs.includes('netAmount'), 'set_2 diff should flag netAmount');
  t.end();
});

test('reconciliation diff: exercises mismatch branch in mixed fixture', (t) => {
  const local: ReconcileRecordLike[] = [
    { id: 'match_1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00' },
    { id: 'mismatch_1', grossAmount: '300.00', feeAmount: '3.00', netAmount: '297.00' },
  ];

  const gateway: ReconcileRecordLike[] = [
    { id: 'match_1', grossAmount: '100.00', feeAmount: '1.00', netAmount: '99.00' },
    { id: 'mismatch_1', grossAmount: '300.00', feeAmount: '5.00', netAmount: '295.00' },
  ];

  const { matchedIds, mismatched } = computeReconciliationDiff(local, gateway);

  t.equal(matchedIds.size, 1, '1 matched row');
  t.ok(matchedIds.has('match_1'), 'match_1 is matched');
  t.notOk(matchedIds.has('mismatch_1'), 'mismatch_1 is not in matchedIds');
  t.equal(mismatched.length, 1, '1 mismatched row');
  t.equal(mismatched[0].id, 'mismatch_1');
  t.deepEqual(mismatched[0].diffs, ['feeAmount', 'netAmount'], 'flags fee and net diffs');
  t.end();
});
