/**
 * rate-limit-nested-ip.test.ts (issue #876)
 *
 * Tests for the nested per-IP limit that applies behind a merchant key:
 * key derivation, normalization, prefix isolation, and independent triggering.
 */
import test from 'tape';
import {
  IP_KEY_PREFIX,
  MERCHANT_KEY_PREFIX,
  buildIpRateLimitKey,
  buildRateLimitKey,
  extractMerchantId,
  needsNestedIpLimit,
  normalizeIp,
  rateLimitIdentityOf,
  resolveClientIp,
  resolveRateLimitIdentity,
} from './rate-limit-key.js';

test('#876: the nested IP key equals ip:<normalized ip> with the documented prefix', (t) => {
  const identity = resolveRateLimitIdentity({
    merchantId: 'merchant-abc',
    ip: normalizeIp('::ffff:192.168.1.1'),
  });
  const key = buildIpRateLimitKey(identity);
  t.equal(key, `${IP_KEY_PREFIX}192.168.1.1`, 'nested key is ip:192.168.1.1');
  t.ok(key.startsWith(IP_KEY_PREFIX), 'carries the ip: prefix');
  t.end();
});

test('#876: the IP ceiling triggers independently of the merchant limit', (t) => {
  // Two merchants behind the same NAT: distinct primary buckets…
  const m1 = resolveRateLimitIdentity({ merchantId: 'm1', ip: '10.0.0.5' });
  const m2 = resolveRateLimitIdentity({ merchantId: 'm2', ip: '10.0.0.5' });

  t.notEqual(buildRateLimitKey(m1), buildRateLimitKey(m2), 'merchant buckets are distinct');
  // …but one shared nested IP bucket, so exhausting it rejects even while
  // each merchant bucket still has headroom.
  t.equal(buildIpRateLimitKey(m1), buildIpRateLimitKey(m2), 'nested IP bucket is shared');
  t.ok(needsNestedIpLimit(m1), 'nested IP limit applies to authenticated traffic');
  t.end();
});

test('#876: normalizeIp strips ::ffff: and lowercases IPv6', (t) => {
  t.equal(normalizeIp('::ffff:192.168.1.1'), '192.168.1.1', 'strips the IPv6-mapped IPv4 prefix');
  t.equal(normalizeIp('2001:DB8::1'), '2001:db8::1', 'lowercases IPv6 input');
  t.equal(normalizeIp('2001:DB8::1%lo0'), '2001:db8::1', 'strips zone ids');
  t.equal(normalizeIp('  192.168.1.1  '), '192.168.1.1', 'trims whitespace');
  t.end();
});

test('#876: merchant and IP keys never collide because they carry different prefixes', (t) => {
  t.notEqual(MERCHANT_KEY_PREFIX, IP_KEY_PREFIX, 'prefixes differ');

  // A merchant id that reads like an IP-prefixed key still cannot collide.
  const sneaky = resolveRateLimitIdentity({
    merchantId: `ip:1.2.3.4`,
    ip: '1.2.3.4',
  });
  t.equal(buildRateLimitKey(sneaky), 'm:ip:1.2.3.4', 'merchant key keeps its m: namespace');
  t.equal(buildIpRateLimitKey(sneaky), 'ip:1.2.3.4', 'IP key keeps its ip: namespace');
  t.notEqual(buildRateLimitKey(sneaky), buildIpRateLimitKey(sneaky), 'namespaces never collide');
  t.end();
});

test('#876: a proxied request resolves its client IP through resolveClientIp before keying', (t) => {
  const verify = () => null;
  const request = {
    headers: {
      'x-forwarded-for': '9.9.9.9, 10.0.0.1',
    },
    ip: '127.0.0.1',
  };

  const identity = rateLimitIdentityOf(request as any, verify);
  t.equal(identity.ip, '9.9.9.9', 'leftmost X-Forwarded-For entry wins, normalized');
  t.equal(buildIpRateLimitKey(identity), 'ip:9.9.9.9', 'nested key derived from the forwarded address');
  t.equal(
    resolveClientIp(undefined, '::ffff:192.168.1.1'),
    '192.168.1.1',
    'falls back to the normalized socket address when unproxied',
  );
  t.end();
});

test('#876: anonymous traffic derives an IP-only identity', (t) => {
  const identity = resolveRateLimitIdentity({ merchantId: null, ip: '8.8.8.8' });
  t.equal(identity.dimension, 'ip', 'anonymous traffic is keyed by IP');
  t.equal(identity.merchantId, null, 'no merchant id');
  t.equal(buildRateLimitKey(identity), 'ip:8.8.8.8', 'primary key is the IP bucket');
  t.notOk(needsNestedIpLimit(identity), 'nested limit is skipped for anonymous traffic to avoid double-counting');
  t.end();
});

test('#876: extractMerchantId falls back to the IP dimension on any token failure', (t) => {
  const verify = (token: string) => {
    if (token === 'good') return { merchantId: 'm-1' };
    throw new Error('bad signature');
  };

  t.equal(extractMerchantId(undefined, verify), null, 'missing header yields null');
  t.equal(extractMerchantId('Bearer good', verify), 'm-1', 'valid bearer yields the merchant id');
  t.equal(extractMerchantId('Bearer bad', verify), null, 'verification failure yields null');
  t.equal(extractMerchantId('NotBearer good', verify), null, 'malformed scheme yields null');
  t.end();
});
