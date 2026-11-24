import test from 'tape';
import { redactReconcileLog } from './reconcile-redaction.js';

test('redacts nested objects and array entries without mutating input', (t) => {
  const input = { details: { merchantId: 'merchant-12345', nested: [{ grossAmount: '100', accountId: 'acct-1234' }] } };
  const redacted = redactReconcileLog(input);
  t.equal(redacted.details.merchantId, 'merc***');
  t.equal(redacted.details.nested[0].grossAmount, '[REDACTED]');
  t.equal(redacted.details.nested[0].accountId, 'acct***');
  t.equal(input.details.nested[0].grossAmount, '100');
  t.end();
});

test('handles circular objects safely', (t) => {
  const input: Record<string, unknown> = { feeAmount: '20' };
  input.self = input;
  const redacted = redactReconcileLog(input);
  t.equal(redacted.feeAmount, '[REDACTED]');
  t.equal(redacted.self, redacted);
  t.end();
});
