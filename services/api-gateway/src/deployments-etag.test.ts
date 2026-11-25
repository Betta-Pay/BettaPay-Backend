import test from 'tape';
import { Networks } from '@stellar/stellar-sdk';
import {
  buildDeploymentsResponse,
  computeDeploymentsEtag,
  deploymentsRouteSchema,
  isEtagMatch,
  paymentEventsRouteSchema,
  paymentsListRouteSchema,
} from './index.js';
import { createTestApp } from './test-utils.js';

test('buildDeploymentsResponse accurately distinguishes mainnet, testnet, and custom networks (#978)', (t) => {
  // Mainnet exact passphrase match
  const mainnet = buildDeploymentsResponse({
    networkPassphrase: Networks.PUBLIC,
    settlementContractId: 'CA_SETTLE_MAIN',
    governanceContractId: 'CA_GOV_MAIN',
  });
  t.equal(
    mainnet.data.contracts[0].explorerUrl,
    'https://stellar.expert/explorer/public/contract/CA_SETTLE_MAIN',
    'mainnet uses stellar.expert public contract URL',
  );
  t.equal(
    mainnet.data.contracts[1].explorerUrl,
    'https://stellar.expert/explorer/public/contract/CA_GOV_MAIN',
    'mainnet governance contract uses stellar.expert public contract URL',
  );

  // Testnet exact passphrase match
  const testnet = buildDeploymentsResponse({
    networkPassphrase: Networks.TESTNET,
    settlementContractId: 'CA_SETTLE_TEST',
    governanceContractId: 'CA_GOV_TEST',
  });
  t.equal(
    testnet.data.contracts[0].explorerUrl,
    'https://lab.stellar.org/r/testnet/contract/CA_SETTLE_TEST',
    'testnet uses stellar lab testnet contract URL',
  );
  t.equal(
    testnet.data.contracts[1].explorerUrl,
    'https://lab.stellar.org/r/testnet/contract/CA_GOV_TEST',
    'testnet governance contract uses stellar lab testnet contract URL',
  );

  // Custom network with substring containing "public global"
  const customWithSubstring = buildDeploymentsResponse({
    networkPassphrase: 'Private Network - not public global - custom',
    settlementContractId: 'CA_SETTLE_CUSTOM',
    governanceContractId: 'CA_GOV_CUSTOM',
  });
  t.equal(
    customWithSubstring.data.contracts[0].explorerUrl,
    null,
    'custom network containing "public global" substring does not misclassify as mainnet',
  );
  t.equal(
    customWithSubstring.data.contracts[1].explorerUrl,
    null,
    'custom network sets explorerUrl to null',
  );

  // Generic custom network
  const custom = buildDeploymentsResponse({
    networkPassphrase: 'Standalone Network ; February 2017',
    settlementContractId: 'CA_SETTLE_STANDALONE',
    governanceContractId: 'CA_GOV_STANDALONE',
  });
  t.equal(custom.data.contracts[0].explorerUrl, null, 'standalone custom network sets explorerUrl to null');
  t.equal(custom.data.contracts[1].explorerUrl, null, 'standalone custom network sets explorerUrl to null');

  // Empty contract IDs produce null explorerUrl, never malformed URL strings
  const emptyContractsMainnet = buildDeploymentsResponse({
    networkPassphrase: Networks.PUBLIC,
    settlementContractId: '',
    governanceContractId: '   ',
  });
  t.equal(emptyContractsMainnet.data.contracts[0].explorerUrl, null, 'empty settlement contract ID produces null explorerUrl');
  t.equal(emptyContractsMainnet.data.contracts[1].explorerUrl, null, 'whitespace governance contract ID produces null explorerUrl');

  const emptyContractsTestnet = buildDeploymentsResponse({
    networkPassphrase: Networks.TESTNET,
    settlementContractId: '',
    governanceContractId: 'CA_GOV_TEST',
  });
  t.equal(emptyContractsTestnet.data.contracts[0].explorerUrl, null, 'empty settlement contract ID on testnet produces null');
  t.equal(
    emptyContractsTestnet.data.contracts[1].explorerUrl,
    'https://lab.stellar.org/r/testnet/contract/CA_GOV_TEST',
    'configured governance contract on testnet has valid explorerUrl',
  );

  t.end();
});

test('GET /api/deployments returns a stable ETag derived from the payload (#918)', async (t) => {
  const { app } = await createTestApp();

  const first = await app.inject({ method: 'GET', url: '/api/deployments' });
  const firstEtag = first.headers.etag;
  t.equal(first.statusCode, 200, 'first request returns 200');
  t.ok(firstEtag, 'response carries an ETag header');

  const second = await app.inject({ method: 'GET', url: '/api/deployments' });
  t.equal(second.statusCode, 200, 'second request returns 200');
  t.equal(second.headers.etag, firstEtag, 'the ETag is stable across requests with unchanged metadata');

  const notModified = await app.inject({
    method: 'GET',
    url: '/api/deployments',
    headers: { 'if-none-match': firstEtag },
  });
  t.equal(notModified.statusCode, 304, 'matching If-None-Match returns 304');
  t.equal(notModified.body, '', '304 has an empty body');
  t.equal(notModified.headers.etag, firstEtag, '304 repeats the current ETag');

  const stale = await app.inject({
    method: 'GET',
    url: '/api/deployments',
    headers: { 'if-none-match': 'W/"stale"' },
  });
  t.equal(stale.statusCode, 200, 'a stale If-None-Match returns the full payload');
  t.equal(JSON.parse(stale.body).data.contracts.length, 2, 'the payload is intact');

  await app.close();
  t.end();
});

test('deployments ETag changes when the underlying deploy metadata changes (#918)', (t) => {
  const a = buildDeploymentsResponse({
    networkPassphrase: 'Test SDF Network ; September 2015',
    settlementContractId: 'CA_SETTLEMENT_1',
    governanceContractId: 'CA_GOVERNANCE_1',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
  const b = buildDeploymentsResponse({
    networkPassphrase: 'Test SDF Network ; September 2015',
    settlementContractId: 'CA_SETTLEMENT_2',
    governanceContractId: 'CA_GOVERNANCE_1',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  const etagA = computeDeploymentsEtag(JSON.stringify(a));
  const etagB = computeDeploymentsEtag(JSON.stringify(b));
  t.notEqual(etagA, etagB, 'a changed contract id produces a different ETag');
  t.equal(etagA, computeDeploymentsEtag(JSON.stringify(a)), 'the same payload produces the same ETag');

  t.ok(isEtagMatch(`"other", ${etagA}`, etagA), 'a tag in a comma-separated list matches');
  t.ok(isEtagMatch('*', etagA), 'a wildcard matches');
  t.notOk(isEtagMatch('W/"other"', etagA), 'an unrelated tag does not match');

  t.end();
});

test('the route contracts document ETag, date boundaries, and event ordering (#918)', (t) => {
  t.ok(
    deploymentsRouteSchema.response[200].headers.ETag,
    '200 response contract documents the ETag header',
  );
  t.ok(
    deploymentsRouteSchema.response[304].headers.ETag,
    '304 response contract documents the ETag header',
  );

  t.ok(
    paymentEventsRouteSchema.description.includes('ledger'),
    'payment events contract documents ledger ordering',
  );

  const from = paymentsListRouteSchema.querystring.properties.from;
  const to = paymentsListRouteSchema.querystring.properties.to;
  t.ok(from, 'payments listing contract documents the from parameter');
  t.ok(to, 'payments listing contract documents the to parameter');
  t.ok(
    from.description.includes('Inclusive'),
    'from is documented as an inclusive boundary',
  );
  t.ok(
    to.description.includes('Inclusive'),
    'to is documented as an inclusive boundary',
  );

  t.end();
});
