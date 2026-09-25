import { z } from 'zod';
import { createValidationContext } from './envAwareSchema.js';

export const DEV_ALLOWED_ORIGINS_DEFAULT = 'http://localhost:3000,http://localhost:5173';

export function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlash.toLowerCase();
}

export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

/**
 * CORS origins schema.
 * @envSpecific Wildcard (*) and HTTP origins are only allowed in development.
 * Production enforces HTTPS-only, non-wildcard origins.
 */
export function hasWildcardOrigin(origins: readonly string[]): boolean {
  return origins.some((origin) => origin === '*');
}

export function assertCorsConfigSafe(
  origins: readonly string[],
  credentials: boolean = false,
): void {
  if (credentials && hasWildcardOrigin(origins)) {
    throw new Error(
      'Wildcard CORS origins are not allowed when credentials are enabled. Configure an explicit ALLOWED_ORIGINS allow-list instead.',
    );
  }
}

export function createCorsOriginsSchema(nodeEnv?: string) {
  const { isProduction } = createValidationContext(nodeEnv);

  return z.array(z.string()).superRefine((origins, ctx) => {
    if (isProduction && origins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ALLOWED_ORIGINS is required in production',
      });
    }

    if (hasWildcardOrigin(origins)) {
      const wildcardIndex = origins.findIndex((origin) => origin === '*');
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [wildcardIndex],
        message: 'Wildcard CORS origin (*) is not allowed. Configure an explicit ALLOWED_ORIGINS allow-list instead.',
      });
      return;
    }

    if (isProduction) {
      origins.forEach((origin, i) => {
        if (!origin.startsWith('https://')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: 'CORS origins must use HTTPS in production.',
          });
        }
      });
    } else {
      origins.forEach((origin, i) => {
        try {
          const url = new URL(origin);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message: `"${origin}" is not a valid URL`,
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `"${origin}" is not a valid URL`,
          });
        }
      });
    }
  });
}

export function resolveAllowedOrigins(
  rawEnv: Record<string, unknown>
): { origins: string[]; error?: string } {
  const nodeEnv = (rawEnv.NODE_ENV as string | undefined) ?? 'development';
  const isProduction = nodeEnv === 'production';

  const raw =
    typeof rawEnv.ALLOWED_ORIGINS === 'string' && rawEnv.ALLOWED_ORIGINS.length > 0
      ? rawEnv.ALLOWED_ORIGINS
      : DEV_ALLOWED_ORIGINS_DEFAULT;

  let origins = parseAllowedOrigins(raw);
  if (isProduction && (rawEnv.ALLOWED_ORIGINS === undefined || rawEnv.ALLOWED_ORIGINS === '')) {
    origins = [];
  }

  if (hasWildcardOrigin(origins)) {
    return {
      origins: [],
      error: 'Wildcard CORS origin (*) is not allowed. Configure an explicit ALLOWED_ORIGINS allow-list instead.',
    };
  }

  const schema = createCorsOriginsSchema(nodeEnv);
  const result = schema.safeParse(origins);

  if (!result.success) {
    return { origins: [], error: result.error.errors[0].message };
  }

  return { origins: result.data };
}
