import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGatewayHealthResponse, parseAbandonmentThresholdMinutes } from './health.js';

const env = {
  FX_ENGINE_URL: 'http://fx:3002',
  SETTLEMENT_ENGINE_URL: 'http://settlement:3001',
  INDEXER_URL: 'http://indexer:3003',
};

const downFetch = (async () => {
  throw new Error('upstream down');
}) as unknown as typeof fetch;

function fakePrisma(queries: string[], serverVersion = 'PostgreSQL 16.2 on x86_64-pc-linux-gnu') {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return [{ serverVersion }];
    },
    payment: { count: async () => 0 },
  } as any;
}

test('gateway health reports the PostgreSQL version() string as serverVersion (#987)', async () => {
  const queries: string[] = [];
  const health = await buildGatewayHealthResponse({
    prisma: fakePrisma(queries),
    env,
    startTime: Date.now(),
    serviceVersion: '0.0.0',
    fetchImpl: downFetch,
  });

  assert.equal(queries.length, 1);
  assert.match(queries[0], /version\(\)/);
  assert.doesNotMatch(queries[0], /NOW\(\)/);

  const postgres = health.dependencies.find((d) => d.name === 'postgresql') as any;
  assert.equal(postgres.status, 'connected');
  assert.equal(postgres.details.serverVersion, 'PostgreSQL 16.2 on x86_64-pc-linux-gnu');
});

test('ABANDONMENT_THRESHOLD_MINUTES falls back to the default for invalid values (#988)', () => {
  for (const bad of [undefined, '', 'abc', 'NaN', 'Infinity', '0', '-5']) {
    assert.equal(parseAbandonmentThresholdMinutes(bad), 1440, `fallback for ${String(bad)}`);
  }
  const cutoff = new Date(Date.now() - parseAbandonmentThresholdMinutes('abc') * 60 * 1000);
  assert.ok(!Number.isNaN(cutoff.getTime()));
});

test('valid ABANDONMENT_THRESHOLD_MINUTES strings override the default (#988)', () => {
  assert.equal(parseAbandonmentThresholdMinutes('30'), 30);
  assert.equal(parseAbandonmentThresholdMinutes('2880'), 2880);
});
