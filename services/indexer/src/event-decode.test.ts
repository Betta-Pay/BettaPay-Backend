/**
 * Tests for indexer event decode failures (#884): decodeScVal, validatePayload
 * and EVENT_SCHEMA_MAP must isolate a bad event so the poll cycle keeps
 * processing the events that follow it.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.DATABASE_URL = 'postgresql://localhost:5432/db';
process.env.SETTLEMENT_CONTRACT_ID = 'CDLZFC3SYXDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.GOVERNANCE_CONTRACT_ID = 'CBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.ADMIN_ADDRESS = 'GBJDHFU7XYDT4MMSTXTU4Z4VABMFR6SPLPNCZF656SIHPXT6LPWEEXGO';
process.env.INTER_SERVICE_SECRET = 'test-service-secret-value';
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(32);

import test from 'tape';
import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';

const { fastify, decodeScVal, validatePayload, EVENT_SCHEMA_MAP } = await import('./index.js');

const MERCHANT = Keypair.random().publicKey();

const validPaymentInitiated = {
  id: 'evt_1',
  type: 'PaymentInitiated',
  occurredAt: '2025-06-10T12:00:00.000Z',
  payload: {
    payment: {
      id: 'pay_1',
      merchantId: MERCHANT,
      amount: '10.00',
      asset: 'USDC',
      status: 'initiated',
      createdAt: '2025-06-10T12:00:00.000Z',
    },
  },
};

const scVal = (value: unknown): xdr.ScVal => nativeToScVal(value);
// Not a real ScVal: scValToNative throws on it, which is what a corrupt event looks like.
const malformedScVal = (): xdr.ScVal => ({ notAScVal: true }) as unknown as xdr.ScVal;

interface Captured {
  ctx: any;
  msg: string;
}

/** Captures fastify.log.warn calls for the duration of `fn`. */
async function captureWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: Captured[] }> {
  const warnings: Captured[] = [];
  const original = (fastify.log as any).warn;
  (fastify.log as any).warn = (ctx: any, msg?: string) => {
    warnings.push({ ctx, msg: msg ?? '' });
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    (fastify.log as any).warn = original;
  }
}

/**
 * Classifies a batch the way the poll loop does per event: decode, then
 * validate, never letting one event's failure escape. Returns the events that
 * decoded and validated cleanly.
 */
function processBatch(events: Array<{ type: string; value: xdr.ScVal }>): unknown[] {
  const processed: unknown[] = [];
  for (const evt of events) {
    const decoded = decodeScVal(evt.value, evt.type);
    if (decoded === undefined) continue;
    if (validatePayload(evt.type, decoded) !== null) continue;
    processed.push(decoded);
  }
  return processed;
}

test('malformed ScVal is logged and skipped without throwing', async (t) => {
  const { result, warnings } = await captureWarnings(() => {
    let threw = false;
    let decoded: unknown = 'unset';
    try {
      decoded = decodeScVal(malformedScVal(), 'PaymentInitiated');
    } catch {
      threw = true;
    }
    return { threw, decoded };
  });

  t.notOk(result.threw, 'decodeScVal does not throw');
  t.equal(result.decoded, undefined, 'decodeScVal yields undefined so the caller skips the payload');
  t.equal(warnings.length, 1, 'one warning logged');
  t.equal(warnings[0].ctx.topicHint, 'PaymentInitiated', 'warning carries the topic hint');
  t.ok(typeof warnings[0].ctx.err === 'string' && warnings[0].ctx.err.length > 0, 'warning carries the error');
  t.ok(warnings[0].msg.includes('Failed to decode XDR'), 'warning message identifies the decode failure');
  t.end();
});

test('a known event type decodes to the schema-validated object via EVENT_SCHEMA_MAP', async (t) => {
  const { result: decoded, warnings } = await captureWarnings(() =>
    decodeScVal(scVal(validPaymentInitiated), 'PaymentInitiated'),
  );

  t.deepEqual(decoded, validPaymentInitiated, 'ScVal decodes back to the original object');
  t.equal(warnings.length, 0, 'no warning for a valid payload');

  const schema = EVENT_SCHEMA_MAP['PaymentInitiated'];
  t.ok(schema, 'PaymentInitiated is registered in EVENT_SCHEMA_MAP');
  const parsed = schema.safeParse(decoded);
  t.ok(parsed.success, 'decoded payload passes the registered schema');
  t.deepEqual(parsed.success && parsed.data, validPaymentInitiated, 'schema-validated object has the expected shape');
  t.equal(validatePayload('PaymentInitiated', decoded), null, 'validatePayload reports no error');
  t.end();
});

test('EVENT_SCHEMA_MAP covers the documented event types', (t) => {
  t.deepEqual(
    Object.keys(EVENT_SCHEMA_MAP).sort(),
    ['AnchorSettled', 'BillPaid', 'FXExecuted', 'PaymentCompleted', 'PaymentInitiated', 'SettlementTriggered'],
    'all known event types are registered',
  );
  t.end();
});

test('an unknown event type is skipped rather than crashing', async (t) => {
  const { result, warnings } = await captureWarnings(() => {
    let threw = false;
    let error: string | null = 'unset';
    try {
      error = validatePayload('SomethingNew', { anything: 'goes' });
    } catch {
      threw = true;
    }
    return { threw, error };
  });

  t.notOk(result.threw, 'validatePayload does not throw for an unknown type');
  t.equal(result.error, null, 'no validation error is produced');
  t.equal(warnings.length, 0, 'nothing is logged for an unknown type');
  t.notOk('SomethingNew' in EVENT_SCHEMA_MAP, 'unknown type has no schema');
  t.end();
});

test('a schema validation failure on a known type is logged and skipped', async (t) => {
  const invalid = { ...validPaymentInitiated, occurredAt: 'not-a-date' };

  const { result, warnings } = await captureWarnings(() => {
    let threw = false;
    let error: string | null = null;
    try {
      error = validatePayload('PaymentInitiated', invalid);
    } catch {
      threw = true;
    }
    return { threw, error };
  });

  t.notOk(result.threw, 'validatePayload does not throw');
  t.ok(result.error && result.error.includes('occurredAt'), 'error names the failing field');
  t.equal(warnings.length, 1, 'one warning logged');
  t.equal(warnings[0].ctx.type, 'PaymentInitiated', 'warning carries the event type');
  t.equal(warnings[0].ctx.validationError, result.error, 'warning carries the validation message');
  t.ok(warnings[0].msg.includes('validation failed'), 'warning message identifies the validation failure');
  t.end();
});

test('a payload of the wrong shape for a known type is rejected', async (t) => {
  const { result: error } = await captureWarnings(() => validatePayload('PaymentInitiated', 'just a string'));
  t.ok(error, 'non-object payload fails validation');
  const { result: nullError } = await captureWarnings(() => validatePayload('PaymentInitiated', null));
  t.ok(nullError, 'null payload fails validation');
  t.end();
});

test('decodeScVal ignores an unsupported topic hint and still decodes', async (t) => {
  const { result: decoded } = await captureWarnings(() =>
    decodeScVal(scVal(validPaymentInitiated), 'UnsupportedTopic'),
  );
  t.deepEqual(decoded, validPaymentInitiated, 'topic hint does not gate decoding');

  const { result: bad, warnings } = await captureWarnings(() => decodeScVal(malformedScVal(), 'UnsupportedTopic'));
  t.equal(bad, undefined, 'malformed payload under an unsupported hint yields undefined, not a throw');
  t.equal(warnings[0].ctx.topicHint, 'UnsupportedTopic', 'hint is only used for logging');
  t.end();
});

test('events after a malformed one in the same batch are still processed', async (t) => {
  const second = { ...validPaymentInitiated, id: 'evt_2' };
  const third = { ...validPaymentInitiated, id: 'evt_3' };

  const { result: processed } = await captureWarnings(() =>
    processBatch([
      { type: 'PaymentInitiated', value: scVal(validPaymentInitiated) },
      { type: 'PaymentInitiated', value: malformedScVal() },
      { type: 'PaymentInitiated', value: scVal(second) },
      { type: 'PaymentInitiated', value: scVal(third) },
    ]),
  );

  t.deepEqual(
    (processed as Array<{ id: string }>).map((p) => p.id),
    ['evt_1', 'evt_2', 'evt_3'],
    'events on both sides of the malformed one are processed',
  );
  t.end();
});

test('processed count reflects only successfully decoded and valid events', async (t) => {
  const { result: processed, warnings } = await captureWarnings(() =>
    processBatch([
      { type: 'PaymentInitiated', value: scVal(validPaymentInitiated) }, // ok
      { type: 'PaymentInitiated', value: malformedScVal() }, // decode failure
      { type: 'PaymentInitiated', value: scVal({ ...validPaymentInitiated, occurredAt: 'bad' }) }, // schema failure
      { type: 'SomethingNew', value: scVal({ a: 1 }) }, // unknown type, decodes with no schema
    ]),
  );

  // The unknown type has no schema to reject it, so it passes through; the two
  // failures are the only ones dropped.
  t.equal(processed.length, 2, 'decode and schema failures are excluded from the count');
  t.equal(warnings.length, 2, 'each failure is logged exactly once');
  t.end();
});

test('a batch of only malformed events yields zero processed and does not throw', async (t) => {
  const { result: processed, warnings } = await captureWarnings(() =>
    processBatch([
      { type: 'PaymentInitiated', value: malformedScVal() },
      { type: 'BillPaid', value: malformedScVal() },
    ]),
  );

  t.equal(processed.length, 0, 'nothing processed');
  t.equal(warnings.length, 2, 'both failures logged');
  t.end();
});

test.onFinish(() => {
  // The indexer module opens Redis/queue connections at import time.
  process.exit(0);
});
