import * as crypto from 'crypto';

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64UrlEncode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Signs a minimal HS256 JWT with Node's native crypto.
 *
 * Used by the reconcile report path to authenticate the settlement engine
 * against the api-gateway with the configured JWT secret.
 */
export function signHS256(payload: object, secret: string): string {
  if (!secret) {
    throw new Error('signHS256: secret is required');
  }

  const tokenInput = `${base64UrlEncode(HEADER)}.${base64UrlEncode(payload)}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(tokenInput)
    .digest('base64url');

  return `${tokenInput}.${signature}`;
}

/**
 * Verifies an HS256 JWT produced by {@link signHS256}.
 *
 * Returns false for malformed tokens, unsupported headers, wrong secrets, and
 * tampered payload or signature segments. The HMAC comparison is constant-time.
 */
export function verifyHS256(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || !secret) return false;

  const [encodedHeader, encodedPayload, providedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !providedSignature) return false;

  try {
    const header = JSON.parse(
      Buffer.from(encodedHeader, 'base64url').toString('utf8'),
    ) as { alg?: unknown; typ?: unknown };
    if (header.alg !== HEADER.alg || header.typ !== HEADER.typ) return false;
  } catch {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const provided = Buffer.from(providedSignature, 'base64url');

  return (
    expectedSignature.length === provided.length &&
    crypto.timingSafeEqual(expectedSignature, provided)
  );
}
