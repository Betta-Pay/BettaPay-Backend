import test from 'tape';
import { createAuthHardening } from './auth-hardening.js';

// Follow-up coverage for #984: the IP score is adjusted by one script call that clamps at zero.

function recordingRedis(result = 1) {
  const calls: { script: string; numKeys: number; args: string[] }[] = [];
  return {
    calls,
    async get() { return null; },
    async eval(script: string, numKeys: number, ...args: string[]) {
      calls.push({ script, numKeys, args });
      return result;
    },
  };
}

test('a failure and a success each make one script call with the right delta and TTL (#984)', async (t) => {
  const redis = recordingRedis();
  const helpers = createAuthHardening(redis as any, () => 'jwt');
  const request = { ip: '198.51.100.7' } as any;

  await helpers.recordAuthIpFailure(request);
  await helpers.recordAuthIpSuccess(request);

  t.equal(redis.calls.length, 2, 'one call per update, no separate read or write');
  t.deepEqual(redis.calls.map((c) => c.args), [
    ['auth_ip_score:198.51.100.7', '1', '900'],
    ['auth_ip_score:198.51.100.7', '-1', '900'],
  ], 'key, delta and a 15 minute TTL');
  t.ok(redis.calls.every((c) => c.numKeys === 1), 'one key per call');
  t.end();
});

test('the score script clamps at zero, deletes a zero score and refreshes the TTL (#984)', async (t) => {
  const redis = recordingRedis();
  const helpers = createAuthHardening(redis as any, () => 'jwt');
  await helpers.recordAuthIpSuccess({ ip: '198.51.100.8' } as any);

  const script = redis.calls[0].script.replace(/\s+/g, ' ');
  t.ok(/if nextScore < 0 then nextScore = 0 end/.test(script), 'a negative result is clamped to zero');
  t.ok(/if nextScore == 0 then redis\.call\('DEL', KEYS\[1\]\)/.test(script), 'a zero score removes the key');
  t.ok(/redis\.call\('SET', KEYS\[1\], tostring\(nextScore\), 'EX', tonumber\(ARGV\[2\]\)\)/.test(script), 'a non-zero score is stored with a fresh TTL');
  t.notOk(/DECRBY|INCRBY/.test(script), 'no separate counter commands that could race with the clamp');
  t.end();
});

test('getAuthIpScore reads a missing key as zero (#984)', async (t) => {
  const helpers = createAuthHardening(recordingRedis() as any, () => 'jwt');

  t.equal(await helpers.getAuthIpScore('198.51.100.9'), 0, 'no key means no failures');
  t.end();
});
