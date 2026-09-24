import test from 'tape';
import {
  env,
  calculateBackoffAfter429,
  calculateBackoffAfterError,
  calculateBackoffAfterSuccess,
  getCurrentBackoffMs,
} from './index.js';

// Issue #535 — the poller must back off on Horizon/RPC 429s, honouring the
// `Retry-After` header, and must not silently drop the poll cycle.

const MAX = env.MAX_BACKOFF_INTERVAL_MS;
const err429 = (retryAfter?: string) => ({
  response: {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  },
});

test('429 with a Retry-After header backs off for that duration (capped at MAX_BACKOFF)', async (t) => {
  const backoff = calculateBackoffAfter429(err429('5'));
  t.equal(backoff, Math.min(5000, MAX), 'Retry-After: 5 -> min(5000ms, MAX)');
  t.equal(getCurrentBackoffMs(), backoff, 'current backoff gauge is updated');
  calculateBackoffAfterSuccess();
  t.end();
});

test('429 with a fetch-style headers.get() accessor is also honoured', async (t) => {
  const backoff = calculateBackoffAfter429({
    response: {
      status: 429,
      headers: { get: (k: string) => (k === 'retry-after' ? '9' : null) },
    },
  });
  t.equal(backoff, Math.min(9000, MAX), 'Retry-After via headers.get -> min(9000ms, MAX)');
  calculateBackoffAfterSuccess();
  t.end();
});

test('429 without a Retry-After header still backs off (exponential, never zero)', async (t) => {
  const before = getCurrentBackoffMs();
  const backoff = calculateBackoffAfter429(err429());
  t.ok(backoff > 0, `no Retry-After -> non-zero backoff (${backoff}ms)`);
  t.ok(backoff >= before, 'backoff does not decrease on a 429');
  calculateBackoffAfterSuccess();
  t.end();
});

test('a bogus Retry-After value falls back to exponential, no NaN / negative', async (t) => {
  for (const bad of ['abc', '-3', '0', '']) {
    const backoff = calculateBackoffAfter429(err429(bad));
    t.ok(Number.isFinite(backoff) && backoff > 0, `Retry-After: "${bad}" -> ${backoff}ms`);
    calculateBackoffAfterSuccess();
  }
  t.end();
});

test('calculateBackoffAfterError routes a 429 through the Retry-After path', async (t) => {
  t.equal(
    calculateBackoffAfterError(err429('7')),
    Math.min(7000, MAX),
    '429 error -> Retry-After honoured',
  );
  calculateBackoffAfterSuccess();
  const generic = calculateBackoffAfterError(new Error('ECONNRESET'));
  t.ok(generic > 0, `non-429 error -> exponential backoff (${generic}ms)`);
  calculateBackoffAfterSuccess();
  t.end();
});

test('a successful poll decays the backoff back toward the base interval', async (t) => {
  calculateBackoffAfter429(err429(String(Math.ceil(MAX / 1000) + 10))); // saturate to MAX
  const raised = getCurrentBackoffMs();
  const afterSuccess = calculateBackoffAfterSuccess();
  t.ok(afterSuccess <= raised, `backoff decreases after success (${raised} -> ${afterSuccess})`);
  t.end();
});
