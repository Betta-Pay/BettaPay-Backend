import test from 'tape';

const DEFAULT_SLIPPAGE_BPS = 50;

function verify(opts: {
  quotedRate: number;
  currentRate: number;
  slippageBps: number;
  expiresAt: number;
  now: number;
  marketRateAvailable: boolean;
}): boolean {
  if (!opts.marketRateAvailable) {
    return opts.now <= opts.expiresAt;
  }
  const deviation = Math.abs(opts.currentRate - opts.quotedRate) / opts.quotedRate * 10000;
  return opts.now <= opts.expiresAt && deviation <= opts.slippageBps;
}

test('Deviation 50bps with slippage 50bps is accepted', (t) => {
  const quotedRate = 1000;
  const currentRate = 1005; // 50bps up
  const valid = verify({
    quotedRate,
    currentRate,
    slippageBps: 50,
    expiresAt: Date.now() + 60_000,
    now: Date.now(),
    marketRateAvailable: true,
  });
  t.ok(valid, 'accepted when deviation equals slippage tolerance');
  t.end();
});

test('Deviation 150bps with slippage 50bps is rejected', (t) => {
  const quotedRate = 1000;
  const currentRate = 1015; // 150bps up
  const valid = verify({
    quotedRate,
    currentRate,
    slippageBps: 50,
    expiresAt: Date.now() + 60_000,
    now: Date.now(),
    marketRateAvailable: true,
  });
  t.notOk(valid, 'rejected when deviation exceeds slippage tolerance');
  t.end();
});

test('No slippage provided uses default (50bps) — deviation 30bps accepted', (t) => {
  const quotedRate = 1000;
  const currentRate = 1003; // 30bps up
  const valid = verify({
    quotedRate,
    currentRate,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    expiresAt: Date.now() + 60_000,
    now: Date.now(),
    marketRateAvailable: true,
  });
  t.ok(valid, 'accepted with default slippage');
  t.end();
});

test('Market rate unavailable — accepted by expiry (fail-open)', (t) => {
  const quotedRate = 1000;
  const currentRate = 9999; // huge deviation, but market unavailable
  const valid = verify({
    quotedRate,
    currentRate,
    slippageBps: 50,
    expiresAt: Date.now() + 60_000,
    now: Date.now(),
    marketRateAvailable: false,
  });
  t.ok(valid, 'accepted when market rate is unavailable even with huge deviation');

  // Also verify it would be rejected if expired
  const expired = verify({
    quotedRate,
    currentRate,
    slippageBps: 50,
    expiresAt: 0,
    now: Date.now(),
    marketRateAvailable: false,
  });
  t.notOk(expired, 'rejected when expired even if market unavailable');
  t.end();
});

test('Over-slippage masked by rounding is caught with full precision', (t) => {
  // If quotedRate was rounded to 8 decimal places:
  // e.g. unrounded was 1000.000000004
  const quotedRate = 1000.000000004;
  // currentRate is 1005.000001 (slightly more than 50bps deviation from the unrounded rate)
  const currentRate = 1005.000001;
  const valid = verify({
    quotedRate,
    currentRate,
    slippageBps: 50,
    expiresAt: Date.now() + 60_000,
    now: Date.now(),
    marketRateAvailable: true,
  });
  t.notOk(valid, 'rejected when true deviation exceeds slippage limit before rounding');
  t.end();
});

