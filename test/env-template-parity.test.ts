import test from 'tape';
import { readFileSync } from 'node:fs';
import { EnvSchema } from '../shared/validation/index.js';

// Known gaps pre-dating this test: warn, don't fail (order-independent).
const GRANDFATHERED = new Set(['INTER_SERVICE_SECRET', 'API_GATEWAY_URL']);

function getEnvShape(schema: any): Record<string, any> {
  let cur = schema;
  while (cur && !cur.shape && cur._def?.schema) {
    cur = cur._def.schema;
  }
  return (schema.shape || cur?.shape) ?? {};
}

function hasDefaultOrOptional(zodType: any): boolean {
  let cur = zodType;
  while (cur) {
    if (cur._def?.defaultValue !== undefined) return true;
    if (cur._def?.typeName === 'ZodOptional' || cur._def?.typeName === 'ZodDefault') return true;
    if (typeof cur.isOptional === 'function' && cur.isOptional()) return true;
    if (cur._def?.innerType) {
      cur = cur._def.innerType;
    } else if (cur._def?.schema) {
      cur = cur._def.schema;
    } else if (cur._def?.in) {
      cur = cur._def.in;
    } else {
      break;
    }
  }
  return false;
}

test('env template covers required schema keys (no NEW gaps)', (t) => {
  const documented = new Set(
    readFileSync('.env.example', 'utf8')
      .split('\n')
      .map((l) => l.split('=')[0].trim())
      .filter((k) => k && !k.startsWith('#')),
  );
  const shape = getEnvShape(EnvSchema);
  const fresh: string[] = [];
  for (const key of Object.keys(shape)) {
    const def = shape[key];
    const hasDefault = def._def?.defaultValue !== undefined;
    const optional = def._def?.typeName === 'ZodOptional' || def._def?.typeName === 'ZodDefault';
    if (!hasDefault && !optional && !hasDefaultOrOptional(def) && !documented.has(key)) {
      if (GRANDFATHERED.has(key)) {
        console.warn(`grandfathered template gap: ${key}`);
      } else {
        fresh.push(key);
      }
    }
  }
  t.deepEqual(fresh, [], 'new undocumented required env keys');
  t.end();
});
