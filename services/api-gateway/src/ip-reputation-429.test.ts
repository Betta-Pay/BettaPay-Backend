import test from 'tape';
import Fastify from 'fastify';
import { createErrorResponse, ErrorCodes } from '@bettapay/validation';
import { createAuthHardening } from './auth-hardening.js';

// Follow-up coverage for #983: a blocked IP gets a 429 and nothing after the hook runs.

function redisWithScores(scores: Record<string, number>) {
  return {
    async get(key: string) {
      const ip = key.replace('auth_ip_score:', '');
      return ip in scores ? String(scores[ip]) : null;
    },
  };
}

async function build(scores: Record<string, number>) {
  const helpers = createAuthHardening(redisWithScores(scores) as any, () => 'jwt');
  const app = Fastify();
  const calls = { second: 0, handler: 0 };
  app.post(
    '/auth',
    {
      preHandler: [
        helpers.enforceAuthIpReputation,
        async () => {
          calls.second += 1;
        },
      ],
    },
    async () => {
      calls.handler += 1;
      return { ok: true };
    },
  );
  await app.ready();
  return { app, calls };
}

test('the 429 uses the shared rate-limited error body and stops later hooks (#983)', async (t) => {
  const { app, calls } = await build({ '10.0.0.1': 20 });
  try {
    const res = await app.inject({ method: 'POST', url: '/auth', remoteAddress: '10.0.0.1' });
    t.equal(res.statusCode, 429, 'blocked');
    t.deepEqual(
      res.json(),
      createErrorResponse(ErrorCodes.RATE_LIMITED, 'Too many failed authentication attempts'),
      'standard error body',
    );
    t.equal(calls.second, 0, 'the next preHandler did not run');
    t.equal(calls.handler, 0, 'the route handler did not run');
  } finally {
    await app.close();
    t.end();
  }
});

test('the block starts exactly at the threshold and is per IP (#983)', async (t) => {
  const { app, calls } = await build({ '10.0.0.2': 19, '10.0.0.3': 20, '10.0.0.4': 500 });
  try {
    const at = async (ip: string) =>
      (await app.inject({ method: 'POST', url: '/auth', remoteAddress: ip })).statusCode;

    t.equal(await at('10.0.0.2'), 200, 'one below the threshold is allowed');
    t.equal(await at('10.0.0.3'), 429, 'the threshold itself is blocked');
    t.equal(await at('10.0.0.4'), 429, 'far above the threshold is blocked');
    t.equal(await at('10.0.0.5'), 200, 'an IP with no score is allowed');
    t.equal(calls.handler, 2, 'only the two allowed requests reached the handler');
  } finally {
    await app.close();
    t.end();
  }
});
