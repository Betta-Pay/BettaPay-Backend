import test from 'node:test';
import assert from 'node:assert';
import {
  DEV_ALLOWED_ORIGINS_DEFAULT,
  normalizeOrigin,
  parseAllowedOrigins,
  resolveAllowedOrigins,
} from './cors.js';

test('normalizeOrigin strips trailing slashes and lowercases', () => {
  assert.strictEqual(normalizeOrigin('HTTPS://Example.COM/'), 'https://example.com');
  assert.strictEqual(normalizeOrigin('http://localhost:3000///'), 'http://localhost:3000');
});

test('parseAllowedOrigins splits and normalizes comma-separated values', () => {
  assert.deepStrictEqual(parseAllowedOrigins('http://localhost:3000/, HTTPS://LOCALHOST:5173/'), [
    'http://localhost:3000',
    'https://localhost:5173',
  ]);
});

test('resolveAllowedOrigins uses a safe explicit dev default and never wildcards', () => {
  const { origins, error } = resolveAllowedOrigins({ NODE_ENV: 'development' });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(origins, parseAllowedOrigins(DEV_ALLOWED_ORIGINS_DEFAULT));
  assert.ok(!origins.includes('*'), 'default list must never include a wildcard origin');
});

test('resolveAllowedOrigins rejects wildcard origins even in development', () => {
  const { origins, error } = resolveAllowedOrigins({
    NODE_ENV: 'development',
    ALLOWED_ORIGINS: '*',
  });
  assert.deepStrictEqual(origins, []);
  assert.match(error ?? '', /Wildcard CORS origin/);
});

test('resolveAllowedOrigins requires explicit value in production', () => {
  const { error } = resolveAllowedOrigins({ NODE_ENV: 'production' });
  assert.match(error ?? '', /required in production/);
});

test('resolveAllowedOrigins rejects invalid URLs', () => {
  const { error } = resolveAllowedOrigins({
    NODE_ENV: 'development',
    ALLOWED_ORIGINS: 'not-a-url',
  });
  assert.match(error ?? '', /not a valid URL/);
});

test('resolveAllowedOrigins accepts valid production origins', () => {
  const { origins, error } = resolveAllowedOrigins({
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: 'https://app.example.com',
  });
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(origins, ['https://app.example.com']);
});
