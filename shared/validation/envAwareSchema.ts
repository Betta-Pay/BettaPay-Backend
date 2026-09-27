import { z } from 'zod';

export type Env = 'production' | 'development' | 'test' | string;

export interface ValidationContext {
  isProduction: boolean;
  env: Env;
}

export function createValidationContext(nodeEnv: Env = process.env.NODE_ENV ?? 'development'): ValidationContext {
  return {
    isProduction: nodeEnv === 'production',
    env: nodeEnv,
  };
}

/**
 * Creates an env-aware Zod schema by calling the provided factory with a
 * {@link ValidationContext} derived from `nodeEnv`.
 *
 * This is the canonical way to build environment-sensitive validation schemas
 * across the BettaPay backend. Consumers pass a factory that receives a
 * pre-built {@link ValidationContext} so they never need to re-derive
 * `isProduction` from raw env strings themselves.
 *
 * @example
 * // Enforce HTTPS-only URLs in production, allow HTTP in dev/test
 * const schema = envAwareSchema(process.env.NODE_ENV, ({ isProduction }) =>
 *   z.string().url().superRefine((url, ctx) => {
 *     if (isProduction && !url.startsWith('https://')) {
 *       ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must use HTTPS in production' });
 *     }
 *   }),
 * );
 */
export function envAwareSchema<T extends z.ZodTypeAny>(
  nodeEnv: Env | undefined,
  factory: (ctx: ValidationContext) => T,
): T {
  const ctx = createValidationContext(nodeEnv ?? process.env.NODE_ENV ?? 'development');
  return factory(ctx);
}
