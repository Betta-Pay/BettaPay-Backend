import test from 'tape';
import { signHS256, verifyHS256 } from './reconcile-signing.js';

const RECONCILE_SECRET = 'super-secret-development-key-please-change';

const payload = {
  sub: 'settlement-engine-reconciler',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 60,
};

test('reconcile payload signed with the configured secret verifies', (t) => {
  const token = signHS256(payload, RECONCILE_SECRET);

  t.equal(token.split('.').length, 3, 'token has three JWT segments');
  t.ok(verifyHS256(token, RECONCILE_SECRET), 'signed payload verifies with the same secret');
  t.notOk(verifyHS256(token, 'a-different-secret'), 'a different secret is rejected');
  t.end();
});

test('reconcile verification rejects a tampered payload', (t) => {
  const token = signHS256(payload, RECONCILE_SECRET);
  const [header, _encodedPayload, signature] = token.split('.');

  const tamperedPayload = Buffer.from(
    JSON.stringify({ ...payload, sub: 'attacker' }),
  ).toString('base64url');

  t.notOk(
    verifyHS256(`${header}.${tamperedPayload}.${signature}`, RECONCILE_SECRET),
    'tampered payload fails verification',
  );
  t.end();
});

test('reconcile verification rejects a tampered signature', (t) => {
  const token = signHS256(payload, RECONCILE_SECRET);
  const [header, encodedPayload, signature] = token.split('.');
  const lastChar = signature.slice(-1);
  const tamperedSignature = `${signature.slice(0, -1)}${lastChar === 'A' ? 'B' : 'A'}`;

  t.notOk(
    verifyHS256(`${header}.${encodedPayload}.${tamperedSignature}`, RECONCILE_SECRET),
    'tampered signature fails verification',
  );
  t.notOk(verifyHS256('not-a-jwt', RECONCILE_SECRET), 'malformed token is rejected');
  t.end();
});
