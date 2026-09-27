import test from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { createValidationContext, envAwareSchema } from './envAwareSchema.js';
import { createWebhookUrlSchema } from './webhookSchema.js';
import { createCorsOriginsSchema } from './cors.js';
import { createMerchantSettings, createUpdateMerchantSettingsBody } from './schemas.js';

// ─── createValidationContext ──────────────────────────────────────────────────

test('EnvAwareSchema Factory - defaults to development when NODE_ENV is undefined', () => {
  const ctx = createValidationContext(undefined);
  assert.strictEqual(ctx.isProduction, false);
  assert.strictEqual(ctx.env, 'development');
});

test('EnvAwareSchema Factory - sets isProduction=true when NODE_ENV=production', () => {
  const ctx = createValidationContext('production');
  assert.strictEqual(ctx.isProduction, true);
  assert.strictEqual(ctx.env, 'production');
});

test('EnvAwareSchema Factory - sets isProduction=false when NODE_ENV=development', () => {
  const ctx = createValidationContext('development');
  assert.strictEqual(ctx.isProduction, false);
  assert.strictEqual(ctx.env, 'development');
});

test('EnvAwareSchema Factory - sets isProduction=false when NODE_ENV=test', () => {
  const ctx = createValidationContext('test');
  assert.strictEqual(ctx.isProduction, false);
  assert.strictEqual(ctx.env, 'test');
});

// ─── envAwareSchema factory ───────────────────────────────────────────────────

test('envAwareSchema - passes ValidationContext to factory fn', () => {
  let capturedCtx: ReturnType<typeof createValidationContext> | undefined;
  envAwareSchema('production', (ctx) => {
    capturedCtx = ctx;
    return z.string();
  });
  assert.ok(capturedCtx);
  assert.strictEqual(capturedCtx!.isProduction, true);
  assert.strictEqual(capturedCtx!.env, 'production');
});

test('envAwareSchema - returns the schema produced by the factory fn', () => {
  const schema = envAwareSchema('production', ({ isProduction }) =>
    z.string().superRefine((url, ctx) => {
      if (isProduction && !url.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must use HTTPS in production' });
      }
    }),
  );

  // Production: HTTP rejected
  assert.strictEqual(schema.safeParse('http://example.com').success, false);
  // Production: HTTPS accepted
  assert.strictEqual(schema.safeParse('https://example.com').success, true);
});

test('envAwareSchema - development mode allows HTTP URLs', () => {
  const schema = envAwareSchema('development', ({ isProduction }) =>
    z.string().superRefine((url, ctx) => {
      if (isProduction && !url.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must use HTTPS in production' });
      }
    }),
  );

  // Development: HTTP accepted
  assert.strictEqual(schema.safeParse('http://example.com').success, true);
  // Development: HTTPS also accepted
  assert.strictEqual(schema.safeParse('https://example.com').success, true);
});

test('envAwareSchema - falls back to development when nodeEnv is undefined', () => {
  const schema = envAwareSchema(undefined, ({ isProduction }) =>
    z.string().superRefine((url, ctx) => {
      if (isProduction && !url.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must use HTTPS in production' });
      }
    }),
  );
  // Defaults to dev — HTTP is fine
  assert.strictEqual(schema.safeParse('http://example.com').success, true);
});

// ─── Webhook URL Schema (env-dependent) ───────────────────────────────────────

test('Webhook URL Schema - Production mode - rejects HTTP URLs', () => {
  const schema = createWebhookUrlSchema('production');
  const result = schema.safeParse('http://example.com/webhook');
  assert.strictEqual(result.success, false);
});

test('Webhook URL Schema - Production mode - accepts HTTPS URLs', () => {
  const schema = createWebhookUrlSchema('production');
  const result = schema.safeParse('https://example.com/webhook');
  assert.strictEqual(result.success, true);
});

test('Webhook URL Schema - Production mode - rejects invalid URLs', () => {
  const schema = createWebhookUrlSchema('production');
  const result = schema.safeParse('not-a-url');
  assert.strictEqual(result.success, false);
});

test('Webhook URL Schema - Development mode - accepts HTTP URLs', () => {
  const schema = createWebhookUrlSchema('development');
  const result = schema.safeParse('http://example.com/webhook');
  assert.strictEqual(result.success, true);
});

test('Webhook URL Schema - Development mode - accepts HTTPS URLs', () => {
  const schema = createWebhookUrlSchema('development');
  const result = schema.safeParse('https://example.com/webhook');
  assert.strictEqual(result.success, true);
});

test('Webhook URL Schema - Development mode - rejects invalid URLs', () => {
  const schema = createWebhookUrlSchema('development');
  const result = schema.safeParse('not-a-url');
  assert.strictEqual(result.success, false);
});

// ─── CORS Origins Schema (env-dependent) ─────────────────────────────────────

test('CORS Origins Schema - Production mode - rejects wildcard origin (*)', () => {
  const schema = createCorsOriginsSchema('production');
  const result = schema.safeParse(['*']);
  assert.strictEqual(result.success, false);
});

test('CORS Origins Schema - Production mode - rejects HTTP origins', () => {
  const schema = createCorsOriginsSchema('production');
  const result = schema.safeParse(['http://example.com']);
  assert.strictEqual(result.success, false);
});

test('CORS Origins Schema - Production mode - accepts HTTPS origins', () => {
  const schema = createCorsOriginsSchema('production');
  const result = schema.safeParse(['https://example.com']);
  assert.strictEqual(result.success, true);
});

test('CORS Origins Schema - rejects wildcard origin (*) in all environments', () => {
  const schema = createCorsOriginsSchema('development');
  const result = schema.safeParse(['*']);
  assert.strictEqual(result.success, false);
});

test('CORS Origins Schema - Development mode - accepts HTTP origins', () => {
  const schema = createCorsOriginsSchema('development');
  const result = schema.safeParse(['http://example.com']);
  assert.strictEqual(result.success, true);
});

test('CORS Origins Schema - Development mode - accepts HTTPS origins', () => {
  const schema = createCorsOriginsSchema('development');
  const result = schema.safeParse(['https://example.com']);
  assert.strictEqual(result.success, true);
});

// ─── MerchantSettings (env-dependent webhookUrl) ─────────────────────────────

test('createMerchantSettings - Production mode - rejects HTTP webhook URL', () => {
  const schema = createMerchantSettings('production');
  const result = schema.safeParse({ webhookUrl: 'http://example.com/hook' });
  assert.strictEqual(result.success, false, 'HTTP webhook URL must be rejected in production');
});

test('createMerchantSettings - Production mode - accepts HTTPS webhook URL', () => {
  const schema = createMerchantSettings('production');
  const result = schema.safeParse({ webhookUrl: 'https://example.com/hook' });
  assert.strictEqual(result.success, true, 'HTTPS webhook URL must be accepted in production');
});

test('createMerchantSettings - Development mode - accepts HTTP webhook URL', () => {
  const schema = createMerchantSettings('development');
  const result = schema.safeParse({ webhookUrl: 'http://localhost:3000/hook' });
  assert.strictEqual(result.success, true, 'HTTP webhook URL must be accepted in development');
});

test('createMerchantSettings - accepts all optional fields absent', () => {
  const schema = createMerchantSettings('development');
  const result = schema.safeParse({});
  assert.strictEqual(result.success, true, 'Empty body must be valid — all fields are optional');
});

// ─── UpdateMerchantSettingsBody (env-dependent webhookUrl) ───────────────────

test('createUpdateMerchantSettingsBody - Production mode - rejects HTTP webhook URL', () => {
  const schema = createUpdateMerchantSettingsBody('production');
  const result = schema.safeParse({ webhookUrl: 'http://example.com/hook' });
  assert.strictEqual(result.success, false, 'HTTP webhook URL must be rejected in production');
});

test('createUpdateMerchantSettingsBody - Production mode - accepts HTTPS webhook URL', () => {
  const schema = createUpdateMerchantSettingsBody('production');
  const result = schema.safeParse({ webhookUrl: 'https://example.com/hook' });
  assert.strictEqual(result.success, true, 'HTTPS webhook URL must be accepted in production');
});

test('createUpdateMerchantSettingsBody - Development mode - accepts HTTP webhook URL', () => {
  const schema = createUpdateMerchantSettingsBody('development');
  const result = schema.safeParse({ webhookUrl: 'http://localhost:3000/hook' });
  assert.strictEqual(result.success, true, 'HTTP webhook URL must be accepted in development');
});
