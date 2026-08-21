import test from 'node:test';
import assert from 'node:assert';
import fc from 'fast-check';
import {
  AmountString,
  CreateMerchantBody,
  CreatePaymentBody,
  CreateSettlementBody,
  DateRangeQuery,
  IdempotencyKeySchema,
  PaginationQuery,
  PositiveAmountString,
  StellarAddressSchema,
  UpdateMerchantSettingsBody,
  MerchantSettings,
  CurrencyCode,
  merchantSchema,
  paymentSchema,
  walletSchema,
  PAYMENT_STATUS_TRANSITIONS,
  SETTLEMENT_STATUS_TRANSITIONS,
  isValidTransition,
} from './schemas.js';

const VALID_STELLAR_PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const INVALID_STELLAR_PUBLIC_KEY = 'merchant-1';

// Webhook URL format/HTTPS/SSRF rules are exercised directly against
// createWebhookUrlSchema in webhookSchema.test.ts. These tests only confirm
// that UpdateMerchantSettingsBody actually wires webhookUrl through that
// schema, since that wiring is the thing most likely to silently break.
test('UpdateMerchantSettingsBody webhookUrl validation', async (t) => {
  await t.test('accepts a valid HTTPS webhook URL', () => {
    const result = UpdateMerchantSettingsBody.safeParse({ webhookUrl: 'https://example.com/hook' });
    assert.strictEqual(result.success, true);
  });

  await t.test('webhookUrl is optional', () => {
    const result = UpdateMerchantSettingsBody.safeParse({});
    assert.strictEqual(result.success, true);
  });

  await t.test('rejects a non-URL string', () => {
    const result = UpdateMerchantSettingsBody.safeParse({ webhookUrl: 'not-a-url' });
    assert.strictEqual(result.success, false);
  });

  await t.test('rejects a URL exceeding 2048 characters', () => {
    const long = 'https://example.com/' + 'a'.repeat(2048);
    const result = UpdateMerchantSettingsBody.safeParse({ webhookUrl: long });
    assert.strictEqual(result.success, false);
  });
});

// ─── Property-based tests for state machine transitions ─────────────────────
test('property: payment status transitions are valid and terminal states are absorbing', async () => {
  const paymentStates = Object.keys(PAYMENT_STATUS_TRANSITIONS);

  fc.assert(
    fc.property(
      fc.constantFrom(...paymentStates),
      fc.array(fc.constantFrom(...paymentStates), { maxLength: 20 }),
      (start, seq) => {
        let cur = start;
        for (const target of seq) {
          const allowed = PAYMENT_STATUS_TRANSITIONS[cur] ?? [];
          const valid = isValidTransition(PAYMENT_STATUS_TRANSITIONS, cur, target);
          if (valid !== allowed.includes(target)) return false;
          if (valid) cur = target;
          // If current is terminal, ensure no transitions are accepted
          const curAllowed = PAYMENT_STATUS_TRANSITIONS[cur] ?? [];
          if (curAllowed.length === 0) {
            for (const s of paymentStates) {
              if (isValidTransition(PAYMENT_STATUS_TRANSITIONS, cur, s)) return false;
            }
          }
        }
        return true;
      }
    ),
    { numRuns: 1000 }
  );
});

test('property: settlement status transitions are valid and terminal states are absorbing', async () => {
  const settlementStates = Object.keys(SETTLEMENT_STATUS_TRANSITIONS);

  fc.assert(
    fc.property(
      fc.constantFrom(...settlementStates),
      fc.array(fc.constantFrom(...settlementStates), { maxLength: 20 }),
      (start, seq) => {
        let cur = start;
        for (const target of seq) {
          const allowed = SETTLEMENT_STATUS_TRANSITIONS[cur] ?? [];
          const valid = isValidTransition(SETTLEMENT_STATUS_TRANSITIONS, cur, target);
          if (valid !== allowed.includes(target)) return false;
          if (valid) cur = target;
          const curAllowed = SETTLEMENT_STATUS_TRANSITIONS[cur] ?? [];
          if (curAllowed.length === 0) {
            for (const s of settlementStates) {
              if (isValidTransition(SETTLEMENT_STATUS_TRANSITIONS, cur, s)) return false;
            }
          }
        }
        return true;
      }
    ),
    { numRuns: 1000 }
  );
});

test('PaginationQuery validation', async (t) => {
  await t.test('Default limit is 50', () => {
    const result = PaginationQuery.parse({});
    assert.strictEqual(result.limit, 50);
  });

  await t.test('Default page is 1', () => {
    const result = PaginationQuery.parse({});
    assert.strictEqual(result.page, 1);
  });

  await t.test('Custom limit works', () => {
    const result = PaginationQuery.parse({ limit: 100 });
    assert.strictEqual(result.limit, 100);
  });

  await t.test('Custom page works', () => {
    const result = PaginationQuery.parse({ page: 3 });
    assert.strictEqual(result.page, 3);
  });

  await t.test('Limit above 100 fails', () => {
    assert.throws(() => PaginationQuery.parse({ limit: 101 }), /Number must be less than or equal to 100/);
  });

  await t.test('Page below 1 fails', () => {
    assert.throws(() => PaginationQuery.parse({ page: 0 }), /Number must be greater than or equal to 1/);
  });

  await t.test('Additional query parameters are accepted with passthrough', () => {
    const PassthroughQuery = PaginationQuery.passthrough();
    const result = PassthroughQuery.parse({ limit: 10, page: 2, sort: 'desc', filter: 'active' }) as any;
    assert.strictEqual(result.limit, 10);
    assert.strictEqual(result.page, 2);
    assert.strictEqual(result.sort, 'desc');
    assert.strictEqual(result.filter, 'active');
  });

  await t.test('Coerces string values to numbers', () => {
    const result = PaginationQuery.parse({ limit: '25', page: '5' });
    assert.strictEqual(result.limit, 25);
    assert.strictEqual(result.page, 5);
  });
});

test('DateRangeQuery validation', async (t) => {
  await t.test('Valid ISO from date passes', () => {
    const from = new Date('2023-01-01').toISOString();
    const result = DateRangeQuery.parse({ from });
    assert.strictEqual(result.from, from);
    assert.ok(result.to); // Default applies
  });

  await t.test('Valid ISO to date passes', () => {
    const to = new Date('2023-12-31').toISOString();
    const result = DateRangeQuery.parse({ to });
    assert.strictEqual(result.to, to);
    assert.strictEqual(result.from, undefined);
  });

  await t.test('Invalid date strings fail', () => {
    assert.throws(() => DateRangeQuery.parse({ from: 'not-a-date' }), /Invalid ISO date string/);
    assert.throws(() => DateRangeQuery.parse({ to: 'also-not-a-date' }), /Invalid ISO date string/);
  });

  await t.test('from earlier than to passes', () => {
    const from = new Date('2023-01-01').toISOString();
    const to = new Date('2023-12-31').toISOString();
    const result = DateRangeQuery.parse({ from, to });
    assert.strictEqual(result.from, from);
    assert.strictEqual(result.to, to);
  });

  await t.test('from after to fails', () => {
    const from = new Date('2023-12-31').toISOString();
    const to = new Date('2023-01-01').toISOString();
    assert.throws(() => DateRangeQuery.parse({ from, to }), /from must be before to/);
  });

  await t.test('Missing to defaults to current time', () => {
    const before = new Date();
    const result = DateRangeQuery.parse({});
    const after = new Date();
    const toDate = new Date(result.to!);
    
    assert.ok(toDate >= before && toDate <= after);
    assert.strictEqual(result.from, undefined);
  });

  await t.test('Missing fields are handled correctly', () => {
    const result = DateRangeQuery.parse({});
    assert.strictEqual(result.from, undefined);
    assert.ok(result.to); // Default applies
  });
});

test('AmountString validation', async (t) => {
  await t.test('Valid numeric strings pass', () => {
    assert.strictEqual(AmountString.parse('123'), '123');
    assert.strictEqual(AmountString.parse('0'), '0');
    assert.strictEqual(AmountString.parse('12.34'), '12.34');
    assert.strictEqual(AmountString.parse('0.0'), '0.0');
  });

  await t.test('Invalid numeric strings fail', () => {
    assert.throws(() => AmountString.parse('abc'), /amount must be a numeric string/);
    assert.throws(() => AmountString.parse('12.34.56'), /amount must be a numeric string/);
    assert.throws(() => AmountString.parse('-12.3'), /amount must be a numeric string/);
  });
});

test('PositiveAmountString validation', async (t) => {
  await t.test('Positive numeric strings pass', () => {
    assert.strictEqual(PositiveAmountString.parse('123'), '123');
    assert.strictEqual(PositiveAmountString.parse('12.34'), '12.34');
    assert.strictEqual(PositiveAmountString.parse('0.01'), '0.01');
  });

  await t.test('Zero fails', () => {
    assert.throws(() => PositiveAmountString.parse('0'), /Amount must be greater than zero/);
    assert.throws(() => PositiveAmountString.parse('0.0'), /Amount must be greater than zero/);
  });

  await t.test('Negative values fail', () => {
    assert.throws(() => PositiveAmountString.parse('-1'), /amount must be a numeric string/);
    assert.throws(() => PositiveAmountString.parse('-0.01'), /amount must be a numeric string/);
  });
});

test('CreatePaymentBody validation', async (t) => {
  await t.test('Valid payment body passes', () => {
    const valid = {
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '100.50',
      asset: 'USDC',
    };
    const result = CreatePaymentBody.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  await t.test('Invalid amount in payment body fails', () => {
    assert.throws(() => CreatePaymentBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: 'abc',
      asset: 'USDC',
    }), /amount must be a numeric string/);
  });
});

test('CreateSettlementBody validation', async (t) => {
  await t.test('Valid single settlement passes', () => {
    const valid = {
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '500',
      asset: 'EURT',
    };
    const result = CreateSettlementBody.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  await t.test('Valid batch settlement passes', () => {
    const valid = {
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      items: [
        { amount: '100.50', asset: 'USDC' },
        { amount: '200', asset: 'EURT' },
      ],
    };
    const result = CreateSettlementBody.parse(valid);
    assert.deepStrictEqual(result, valid);
  });

  await t.test('Invalid amount in single settlement fails', () => {
    assert.throws(() => CreateSettlementBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '-50',
      asset: 'EURT',
    }), /amount must be a numeric string/);
  });

  await t.test('Invalid amount in batch settlement items fails', () => {
    assert.throws(() => CreateSettlementBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      items: [
        { amount: '100.50', asset: 'USDC' },
        { amount: 'abc', asset: 'EURT' },
      ],
    }), /amount must be a numeric string/);
  });
});

test('IdempotencyKeySchema validation', async (t) => {
  await t.test('Valid UUID v4 passes', () => {
    const key = '550e8400-e29b-41d4-a716-446655440000';
    const result = IdempotencyKeySchema.parse(key);
    assert.strictEqual(result, key);
  });

  await t.test('Non-UUID string fails', () => {
    assert.throws(
      () => IdempotencyKeySchema.parse('not-a-uuid'),
      /idempotencyKey must be a valid UUID/
    );
  });

  await t.test('Empty string fails', () => {
    assert.throws(
      () => IdempotencyKeySchema.parse(''),
      /idempotencyKey must be a valid UUID/
    );
  });

  await t.test('UUID with wrong format fails', () => {
    assert.throws(
      () => IdempotencyKeySchema.parse('550e8400-e29b-41d4-a716'),
      /idempotencyKey must be a valid UUID/
    );
  });

  await t.test('CreatePaymentBody accepts optional idempotencyKey', () => {
    const key = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const result = CreatePaymentBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '100.00',
      asset: 'USDC',
      idempotencyKey: key,
    });
    assert.strictEqual(result.idempotencyKey, key);
  });

  await t.test('CreatePaymentBody works without idempotencyKey', () => {
    const result = CreatePaymentBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '100.00',
      asset: 'USDC',
    });
    assert.strictEqual(result.idempotencyKey, undefined);
  });

  await t.test('CreatePaymentBody rejects invalid idempotencyKey', () => {
    assert.throws(
      () => CreatePaymentBody.parse({
        merchantId: VALID_STELLAR_PUBLIC_KEY,
        amount: '100.00',
        asset: 'USDC',
        idempotencyKey: 'not-a-uuid',
      }),
      /idempotencyKey must be a valid UUID/
    );
  });

  await t.test('CreateSettlementBody accepts optional idempotencyKey', () => {
    const key = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const result = CreateSettlementBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '500.00',
      asset: 'USDC',
      idempotencyKey: key,
    });
    assert.strictEqual(result.idempotencyKey, key);
  });

  await t.test('CreateSettlementBody works without idempotencyKey', () => {
    const result = CreateSettlementBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      amount: '500.00',
      asset: 'USDC',
    });
    assert.strictEqual(result.idempotencyKey, undefined);
  });

  await t.test('CreateSettlementBody rejects invalid idempotencyKey', () => {
    assert.throws(
      () => CreateSettlementBody.parse({
        merchantId: VALID_STELLAR_PUBLIC_KEY,
        amount: '500.00',
        asset: 'USDC',
        idempotencyKey: 'bad-key',
      }),
      /idempotencyKey must be a valid UUID/
    );
  });
});

test('StellarAddressSchema validation', async (t) => {
  await t.test('Valid Stellar public key passes', () => {
    const result = StellarAddressSchema.parse(VALID_STELLAR_PUBLIC_KEY);
    assert.strictEqual(result, VALID_STELLAR_PUBLIC_KEY);
  });

  await t.test('Invalid Stellar public key fails with descriptive message', () => {
    assert.throws(
      () => StellarAddressSchema.parse(INVALID_STELLAR_PUBLIC_KEY),
      /Invalid Stellar public key/
    );
  });

  await t.test('CreateMerchantBody validates ownerId as a Stellar address', () => {
    const result = CreateMerchantBody.parse({
      id: 'merchant-1',
      name: 'Betta Merchant',
      ownerId: VALID_STELLAR_PUBLIC_KEY,
    });

    assert.strictEqual(result.ownerId, VALID_STELLAR_PUBLIC_KEY);
  });

  await t.test('CreateMerchantBody rejects invalid ownerId', () => {
    assert.throws(
      () => CreateMerchantBody.parse({
        id: 'merchant-1',
        name: 'Betta Merchant',
        ownerId: INVALID_STELLAR_PUBLIC_KEY,
      }),
      /Invalid Stellar public key/
    );
  });

  await t.test('CreatePaymentBody validates merchantId and payerId as Stellar addresses', () => {
    const result = CreatePaymentBody.parse({
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      payerId: VALID_STELLAR_PUBLIC_KEY,
      amount: '100.00',
      asset: 'USDC',
    });

    assert.strictEqual(result.merchantId, VALID_STELLAR_PUBLIC_KEY);
    assert.strictEqual(result.payerId, VALID_STELLAR_PUBLIC_KEY);
  });

  await t.test('CreatePaymentBody rejects invalid merchantId', () => {
    assert.throws(
      () => CreatePaymentBody.parse({
        merchantId: INVALID_STELLAR_PUBLIC_KEY,
        amount: '100.00',
        asset: 'USDC',
      }),
      /Invalid Stellar public key/
    );
  });

  await t.test('Entity schemas use StellarAddressSchema where Stellar addresses are expected', () => {
    assert.strictEqual(merchantSchema.parse({
      id: 'merchant-1',
      name: 'Betta Merchant',
      ownerId: VALID_STELLAR_PUBLIC_KEY,
      createdAt: new Date().toISOString(),
    }).ownerId, VALID_STELLAR_PUBLIC_KEY);

    assert.strictEqual(walletSchema.parse({
      id: 'wallet-1',
      ownerId: VALID_STELLAR_PUBLIC_KEY,
      address: VALID_STELLAR_PUBLIC_KEY,
      asset: 'USDC',
      balance: '0',
    }).address, VALID_STELLAR_PUBLIC_KEY);

    assert.strictEqual(paymentSchema.parse({
      id: 'payment-1',
      merchantId: VALID_STELLAR_PUBLIC_KEY,
      payerId: VALID_STELLAR_PUBLIC_KEY,
      amount: '100.00',
      asset: 'USDC',
      status: 'initiated',
      createdAt: new Date().toISOString(),
    }).merchantId, VALID_STELLAR_PUBLIC_KEY);
  });
});

test('MerchantSettings and UpdateMerchantSettingsBody validation', async (t) => {
  await t.test('accepts valid merchant settings and does not modify clean fields', () => {
    const validPayload = {
      businessName: 'Valid Merchant LLC',
      supportEmail: 'support@valid.com',
      supportAddress: '123 Main St, Springfield',
      tier: 'premium',
      feeBps: 150,
      autoSettle: true,
      preferredAsset: 'USDC',
    };

    const parsed = UpdateMerchantSettingsBody.parse(validPayload);
    assert.strictEqual(parsed.businessName, 'Valid Merchant LLC');
    assert.strictEqual(parsed.supportEmail, 'support@valid.com');
    assert.strictEqual(parsed.supportAddress, '123 Main St, Springfield');
    assert.strictEqual(parsed.tier, 'premium');
    assert.strictEqual(parsed.feeBps, 150);
    assert.strictEqual(parsed.autoSettle, true);
    assert.strictEqual(parsed.preferredAsset, 'USDC');
  });

  await t.test('escapes HTML in free-text fields to prevent XSS', () => {
    const maliciousPayload = {
      businessName: '<script>alert("xss")</script> Name',
      supportAddress: '<img src=x onerror=alert(1)> Address',
      tier: '<b>bold</b> tier',
    };

    const parsed = UpdateMerchantSettingsBody.parse(maliciousPayload);
    assert.strictEqual(parsed.businessName, '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt; Name');
    assert.strictEqual(parsed.supportAddress, '&lt;img src=x onerror=alert(1)&gt; Address');
    assert.strictEqual(parsed.tier, '&lt;b&gt;bold&lt;&#x2F;b&gt; tier');
  });

  await t.test('rejects invalid email formats', () => {
    assert.throws(
      () => UpdateMerchantSettingsBody.parse({ supportEmail: 'not-an-email' }),
      /Invalid supportEmail format/
    );
  });

  await t.test('rejects values exceeding length caps', () => {
    const longName = 'A'.repeat(101);
    const longAddress = 'B'.repeat(256);
    const longTier = 'C'.repeat(51);
    const longEmail = 'D'.repeat(250) + '@example.com';

    assert.throws(
      () => UpdateMerchantSettingsBody.parse({ businessName: longName }),
      /businessName must be at most 100 characters/
    );

    assert.throws(
      () => UpdateMerchantSettingsBody.parse({ supportAddress: longAddress }),
      /supportAddress must be at most 255 characters/
    );

    assert.throws(
      () => UpdateMerchantSettingsBody.parse({ tier: longTier }),
      /tier must be at most 50 characters/
    );

    assert.throws(
      () => UpdateMerchantSettingsBody.parse({ supportEmail: longEmail }),
      /supportEmail must be at most 255 characters/
    );
  });

  await t.test('MerchantSettings behaves similarly with validation, length caps and escaping', () => {
    const maliciousPayload = {
      businessName: '<h1>Company</h1>',
      supportEmail: 'support@company.com',
      supportAddress: '<div class="addr">123 Lane</div>',
      tier: '<script>tier</script>',
    };

    const parsed = MerchantSettings.parse(maliciousPayload);
    assert.strictEqual(parsed.businessName, '&lt;h1&gt;Company&lt;&#x2F;h1&gt;');
    assert.strictEqual(parsed.supportAddress, '&lt;div class=&quot;addr&quot;&gt;123 Lane&lt;&#x2F;div&gt;');
    assert.strictEqual(parsed.tier, '&lt;script&gt;tier&lt;&#x2F;script&gt;');
  });
});
