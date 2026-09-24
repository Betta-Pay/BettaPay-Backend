import test from 'tape';

const QUOTE_TTL_MS = 60_000;
const QUOTE_MIN_AGE_MS = 1000;
const QUOTE_MAX_LIFETIME_MS = 300_000;

type VerifyResult =
  | { valid: boolean }
  | { error: { code: string; message: string } };

function isError(r: VerifyResult): r is { error: { code: string; message: string } } {
  return 'error' in r;
}

function verify(opts: {
  createdAt: number;
  now: number;
  expiresAt: number;
  quotedRate: number;
  currentRate: number;
  slippageBps: number;
  marketRateAvailable: boolean;
}): VerifyResult {
  const quoteAge = opts.now - opts.createdAt;

  if (quoteAge < QUOTE_MIN_AGE_MS) {
    return { error: { code: 'QUOTE_TOO_YOUNG', message: 'Quote too young' } };
  }
  if (quoteAge > QUOTE_MAX_LIFETIME_MS) {
    return { error: { code: 'QUOTE_TOO_OLD', message: 'Quote too old' } };
  }

  let valid: boolean;
  if (!opts.marketRateAvailable) {
    valid = opts.now <= opts.expiresAt;
  } else {
    const deviation =
      Math.abs(opts.currentRate - opts.quotedRate) / opts.quotedRate * 10000;
    valid = opts.now <= opts.expiresAt && deviation <= opts.slippageBps;
  }
  return { valid };
}

// ── Required cases ──────────────────────────────────────────────────────────

test('Quote created 500ms ago is rejected (too young)', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - 500,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(isError(result), 'should return an error');
  if (isError(result)) {
    t.equal(result.error.code, 'QUOTE_TOO_YOUNG', 'error code should be QUOTE_TOO_YOUNG');
  }
  t.end();
});

test('Quote created 2s ago is accepted', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - 2000,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(!isError(result), 'should not return an error');
  if (!isError(result)) {
    t.ok(result.valid, 'quote should be valid');
  }
  t.end();
});

test('Quote created 6 minutes ago is rejected (too old)', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - 6 * 60 * 1000,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(isError(result), 'should return an error');
  if (isError(result)) {
    t.equal(result.error.code, 'QUOTE_TOO_OLD', 'error code should be QUOTE_TOO_OLD');
  }
  t.end();
});

// ── Boundary coverage ───────────────────────────────────────────────────────

test('Exactly at QUOTE_MIN_AGE_MS is accepted', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - QUOTE_MIN_AGE_MS,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(!isError(result), 'should not return an error');
  if (!isError(result)) {
    t.ok(result.valid, 'quote should be valid');
  }
  t.end();
});

test('Exactly at QUOTE_MAX_LIFETIME_MS is accepted', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - QUOTE_MAX_LIFETIME_MS,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(!isError(result), 'should not return an error');
  if (!isError(result)) {
    t.ok(result.valid, 'quote should be valid');
  }
  t.end();
});

test('Just below QUOTE_MIN_AGE_MS (999ms) is rejected (too young)', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - (QUOTE_MIN_AGE_MS - 1),
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(isError(result), 'should return an error');
  if (isError(result)) {
    t.equal(result.error.code, 'QUOTE_TOO_YOUNG', 'error code should be QUOTE_TOO_YOUNG');
  }
  t.end();
});

test('Just above QUOTE_MAX_LIFETIME_MS (300001ms) is rejected (too old)', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - (QUOTE_MAX_LIFETIME_MS + 1),
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(isError(result), 'should return an error');
  if (isError(result)) {
    t.equal(result.error.code, 'QUOTE_TOO_OLD', 'error code should be QUOTE_TOO_OLD');
  }
  t.end();
});

// ── Property / randomised test ──────────────────────────────────────────────

test('Random timestamps around both boundaries produce correct outcomes', (t) => {
  const now = Date.now();
  const trials = 200;

  for (let i = 0; i < trials; i++) {
    const offset = Math.floor(Math.random() * 2 * QUOTE_MAX_LIFETIME_MS);
    const createdAt = now - offset;
    const result = verify({
      createdAt,
      now,
      expiresAt: createdAt + QUOTE_TTL_MS,
      quotedRate: 1000,
      currentRate: 1000,
      slippageBps: 50,
      marketRateAvailable: true,
    });

    if (offset < QUOTE_MIN_AGE_MS) {
      t.ok(isError(result), `offset ${offset}ms should be too young`);
      if (isError(result)) {
        t.equal(result.error.code, 'QUOTE_TOO_YOUNG', `offset ${offset}ms error code`);
      }
    } else if (offset > QUOTE_MAX_LIFETIME_MS) {
      t.ok(isError(result), `offset ${offset}ms should be too old`);
      if (isError(result)) {
        t.equal(result.error.code, 'QUOTE_TOO_OLD', `offset ${offset}ms error code`);
      }
    } else {
      t.ok(!isError(result), `offset ${offset}ms should be valid`);
    }
  }

  t.end();
});

// ── Existing expiry behaviour is preserved ──────────────────────────────────

test('Age-valid but expired quote is rejected', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - 2000,
    now,
    expiresAt: now - 1000,
    quotedRate: 1000,
    currentRate: 1000,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(!isError(result), 'should not return an age error');
  if (!isError(result)) {
    t.notOk(result.valid, 'quote should be invalid due to expiry');
  }
  t.end();
});

test('Age-valid quote with excessive slippage is rejected', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - 2000,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 1100,
    slippageBps: 50,
    marketRateAvailable: true,
  });
  t.ok(!isError(result), 'should not return an age error');
  if (!isError(result)) {
    t.notOk(result.valid, 'quote should be invalid due to slippage');
  }
  t.end();
});

test('Age-valid quote with market unavailable respects fail-open behaviour', (t) => {
  const now = Date.now();
  const result = verify({
    createdAt: now - 2000,
    now,
    expiresAt: now + QUOTE_TTL_MS,
    quotedRate: 1000,
    currentRate: 9999,
    slippageBps: 50,
    marketRateAvailable: false,
  });
  t.ok(!isError(result), 'should not return an age error');
  if (!isError(result)) {
    t.ok(result.valid, 'quote should be valid (fail-open)');
  }

  // Also verify expired + market unavailable still rejects
  const expired = verify({
    createdAt: now - 2000,
    now,
    expiresAt: now - 1000,
    quotedRate: 1000,
    currentRate: 9999,
    slippageBps: 50,
    marketRateAvailable: false,
  });
  t.ok(!isError(expired), 'should not return an age error');
  if (!isError(expired)) {
    t.notOk(expired.valid, 'quote should be invalid due to expiry');
  }
  t.end();
});
