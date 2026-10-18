/**
 * horizon-url-builder.test.ts (issue #873)
 *
 * horizonUrlBuilder maps known networks to their Horizon base URLs, rejects
 * unknown networks early, and normalizes trailing slashes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StellarNetwork, horizonUrlBuilder, buildHorizonUrl } from './index.js';

test('horizonUrlBuilder — known networks map to their Horizon base URLs', async (t) => {
  await t.test('public', () => {
    assert.equal(
      horizonUrlBuilder(StellarNetwork.PUBLIC, 'accounts'),
      'https://horizon.stellar.org/accounts',
    );
  });

  await t.test('testnet', () => {
    assert.equal(
      horizonUrlBuilder(StellarNetwork.TESTNET, 'accounts'),
      'https://horizon-testnet.stellar.org/accounts',
    );
  });

  await t.test('futurenet', () => {
    assert.equal(
      horizonUrlBuilder(StellarNetwork.FUTURENET, 'payments'),
      'https://horizon-futurenet.stellar.org/payments',
    );
  });
});

test('horizonUrlBuilder — unknown or empty networks are rejected', async (t) => {
  await t.test('unknown network string throws', () => {
    assert.throws(
      () => horizonUrlBuilder('mainnet' as StellarNetwork, 'accounts'),
      (err: unknown) =>
        err instanceof TypeError && /Unsupported Stellar network/.test((err as TypeError).message),
    );
  });

  await t.test('empty network throws', () => {
    assert.throws(() => horizonUrlBuilder('' as StellarNetwork, 'accounts'), TypeError);
  });

  await t.test('case variants are rejected — only the exact lowercase names are known', () => {
    assert.throws(() => horizonUrlBuilder('PUBLIC' as StellarNetwork, 'accounts'), TypeError);
    assert.throws(() => horizonUrlBuilder('Testnet' as StellarNetwork, 'accounts'), TypeError);
  });
});

test('horizonUrlBuilder — paths join without doubling slashes', async (t) => {
  await t.test('resource paths attach with exactly one separator', () => {
    const url = horizonUrlBuilder(StellarNetwork.PUBLIC, 'ledgers');
    assert.equal(url, 'https://horizon.stellar.org/ledgers');
    assert.ok(!url.includes('//ledgers'), 'no doubled slash before the resource');
  });

  await t.test('query parameters are appended and encoded', () => {
    const url = horizonUrlBuilder(StellarNetwork.TESTNET, 'transactions', {
      limit: 10,
      order: 'desc',
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('limit'), '10');
    assert.equal(parsed.searchParams.get('order'), 'desc');
  });
});

test('buildHorizonUrl — trailing slashes are normalized', async (t) => {
  await t.test('a single trailing slash is stripped', () => {
    assert.equal(
      buildHorizonUrl('https://horizon.stellar.org/', 'payments'),
      'https://horizon.stellar.org/payments',
    );
  });

  await t.test('the slashed and unslashed forms produce identical output', () => {
    const a = buildHorizonUrl('https://horizon.stellar.org', 'payments', { limit: 5 });
    const b = buildHorizonUrl('https://horizon.stellar.org/', 'payments', { limit: 5 });
    assert.equal(a, b, 'trailing slash does not change the canonical form');
  });

  await t.test('null and undefined params are omitted', () => {
    const url = buildHorizonUrl('https://horizon.stellar.org', 'accounts', {
      signer: null,
      limit: undefined,
      asset: 'USD:GABC',
    });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('signer'), null);
    assert.equal(parsed.searchParams.get('asset'), 'USD:GABC');
  });
});
