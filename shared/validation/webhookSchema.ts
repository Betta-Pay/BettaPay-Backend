import { z } from 'zod';
import { Redis } from 'ioredis';
import dns from 'node:dns';
import net from 'node:net';
import { createValidationContext } from './envAwareSchema.js';

/**
 * Checks whether an IP address belongs to private, loopback, link-local,
 * multicast, reserved, or cloud metadata address ranges.
 */
export function isPrivateOrRestrictedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (!family) return false;

  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [b0, b1] = parts;
    // 0.0.0.0/8 (current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (private)
    if (b0 === 10) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // 127.0.0.0/8 (loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (link-local / cloud metadata e.g. 169.254.169.254)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (private 172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1)
    if (b0 === 192 && b1 === 0) return true;
    // 192.168.0.0/16 (private)
    if (b0 === 192 && b1 === 168) return true;
    // 198.18.0.0/15 (benchmarking)
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (b0 === 198 && b1 === 51) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (b0 === 203 && b1 === 0) return true;
    // 224.0.0.0/4 (multicast)
    if (b0 >= 224 && b0 <= 239) return true;
    // 240.0.0.0/4 (reserved)
    if (b0 >= 240) return true;
    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();
    // Unspecified / loopback
    if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') {
      return true;
    }
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    if (lower.startsWith('::ffff:')) {
      const v4Part = lower.slice(7);
      if (net.isIPv4(v4Part)) {
        return isPrivateOrRestrictedIp(v4Part);
      }
    }
    // Unique local (fc00::/7)
    if (/^f[cd][0-9a-f]{2}:/i.test(lower) || lower.startsWith('fc') || lower.startsWith('fd')) {
      return true;
    }
    // Link-local (fe80::/10)
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) {
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Checks whether a hostname matches the configurable host allowlist.
 * Supports exact hostname matches and wildcards (*.example.com or *).
 */
export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  const normalizedHost = host.toLowerCase().trim();
  for (const pattern of allowedHosts) {
    const p = pattern.toLowerCase().trim();
    if (p === '*') return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      if (normalizedHost.endsWith(suffix) || normalizedHost === p.slice(2)) {
        return true;
      }
    } else if (normalizedHost === p) {
      return true;
    }
  }
  return false;
}

export interface WebhookTestTargetValidation {
  allowed: boolean;
  reason?: string;
}

/**
 * Validates a target URL for the indexer webhook test endpoint (#900).
 * Enforces scheme allowlist (http/https), host allowlist, and blocks
 * private, loopback, link-local, and metadata IP addresses.
 */
export async function validateWebhookTestTarget(
  urlString: string,
  allowedHosts: string[],
  dnsResolver?: (hostname: string) => Promise<string[]>,
): Promise<WebhookTestTargetValidation> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Invalid target URL format' };
  }

  // 1. Validate scheme against http and https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      reason: `Invalid URL scheme "${url.protocol}". Only http and https are allowed.`,
    };
  }

  const hostname = url.hostname;

  // 2. Validate host against configurable host allowlist
  if (!isHostAllowed(hostname, allowedHosts)) {
    return {
      allowed: false,
      reason: `Host "${hostname}" is not in the webhook test allowlist.`,
    };
  }

  // If hostname is directly an IP, verify it is not private/restricted
  if (net.isIP(hostname)) {
    if (isPrivateOrRestrictedIp(hostname)) {
      return {
        allowed: false,
        reason: `IP address "${hostname}" is in a private, loopback, or metadata range.`,
      };
    }
    return { allowed: true };
  }

  // 3. DNS resolution & blocking private/loopback/metadata ranges
  try {
    const resolve =
      dnsResolver ??
      (async (host: string) => {
        const results = await dns.promises.lookup(host, { all: true });
        return results.map((r) => r.address);
      });

    const addresses = await resolve(hostname);
    if (!addresses || addresses.length === 0) {
      return {
        allowed: false,
        reason: `Could not resolve hostname "${hostname}".`,
      };
    }

    for (const ip of addresses) {
      if (isPrivateOrRestrictedIp(ip)) {
        return {
          allowed: false,
          reason: `Resolved IP "${ip}" for host "${hostname}" is in a private, loopback, or metadata range.`,
        };
      }
    }
  } catch (err: any) {
    return {
      allowed: false,
      reason: `DNS resolution failed for host "${hostname}": ${err?.message || String(err)}`,
    };
  }

  return { allowed: true };
}

const PRIVATE_HOST_PATTERN =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|::1|\[::1\]|0\.0\.0\.0)$/i;

function isPrivateOrLocalhost(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);
    return PRIVATE_HOST_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

export const WEBHOOK_VALIDATE_RATE_LIMIT = 10;
export const WEBHOOK_VALIDATE_RATE_WINDOW_SEC = 60;
export const DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { addresses: string[]; timestamp: number }>();

export async function checkWebhookRateLimit(redis: Redis, ip: string): Promise<boolean> {
  const key = `webhook_validate_rate:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WEBHOOK_VALIDATE_RATE_WINDOW_SEC);
  }
  return count <= WEBHOOK_VALIDATE_RATE_LIMIT;
}

export async function resolveWithCache(url: string): Promise<string[]> {
  const { hostname } = new URL(url);
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL_MS) {
    return cached.addresses;
  }
  try {
    const addresses = await dns.promises.resolve4(hostname);
    dnsCache.set(hostname, { addresses, timestamp: Date.now() });
    return addresses;
  } catch {
    return [];
  }
}

export function clearDnsCache(): void {
  dnsCache.clear();
}

export interface WebhookValidationResult {
  valid: boolean;
  error?: string;
  statusCode?: number;
}

export async function validateWebhookUrl(
  url: string,
  redis: Redis,
  ip: string,
  options?: { fetch?: typeof globalThis.fetch },
): Promise<WebhookValidationResult> {
  const allowed = await checkWebhookRateLimit(redis, ip);
  if (!allowed) {
    return { valid: false, error: 'Rate limit exceeded. Please try again later.', statusCode: 429 };
  }

  const addresses = await resolveWithCache(url);
  if (addresses.length === 0) {
    return { valid: false, error: 'Could not resolve webhook URL', statusCode: 400 };
  }

  const doFetch = options?.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await doFetch(url, { method: 'HEAD', signal: controller.signal });
    if (response.ok) {
      return { valid: true, statusCode: response.status };
    }
    return { valid: false, error: 'Webhook URL is not reachable', statusCode: response.status };
  } catch {
    return { valid: false, error: 'Webhook URL is not reachable', statusCode: 400 };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createWebhookUrlSchema(nodeEnv?: string) {
  const { isProduction } = createValidationContext(nodeEnv);

  return z
    .string()
    .url('Webhook URL must be a valid URL')
    .max(2048, 'Webhook URL must not exceed 2048 characters')
    .superRefine((url, ctx) => {
      if (!isProduction) return;

      if (!url.startsWith('https://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Webhook URLs must use HTTPS in production.',
        });
      }

      if (isPrivateOrLocalhost(url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Webhook URL must not point to localhost or private IP addresses',
        });
      }
    });
}

export const WebhookUrlSchema = createWebhookUrlSchema();

export type WebhookUrl = z.infer<typeof WebhookUrlSchema>;

/**
 * Event payloads delivered to webhook consumers carry a semantic version string.
 * Consumers should branch their logic based on this version field to ensure
 * backwards compatibility when payload shapes change in the future.
 */
export const WebhookPayloadSchema = z.object({
  version: z.string().min(1, 'version is required').describe('Event payload version, e.g. "1.0"'),
  event: z.record(z.unknown()).describe('The indexed event data'),
});

// ─── Custom webhook headers (#569) ─────────────────────────────────────────
//
// Merchants can configure custom headers (idempotency keys, bearer tokens,
// etc.) to be sent with every webhook delivery attempt, including retries.
// `Content-Type` and `X-BettaPay-Signature` are reserved: the delivery worker
// (@bettapay/webhook-delivery) always controls those two, but we also reject
// them at the API boundary so misconfiguration surfaces immediately instead
// of silently being dropped at delivery time.

const HTTP_TOKEN_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
// `content-type`/`x-bettapay-signature` are ours to control (see comment
// above). `host`/`content-length`/`transfer-encoding`/`connection` are
// reserved for a different reason (#607): they are meaningful to whatever
// HTTP client actually sends the request, so letting a merchant set them
// risks request-smuggling / response-splitting-style header confusion at
// delivery time, not just a misconfiguration on our side.
const RESERVED_WEBHOOK_HEADER_NAMES = new Set([
  'content-type',
  'x-bettapay-signature',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);
const MAX_CUSTOM_WEBHOOK_HEADERS = 20;

export const WebhookHeadersSchema = z
  .record(z.string(), z.string().max(4096, 'Header value must not exceed 4096 characters'))
  .refine((headers) => Object.keys(headers).length <= MAX_CUSTOM_WEBHOOK_HEADERS, {
    message: `A maximum of ${MAX_CUSTOM_WEBHOOK_HEADERS} custom headers is allowed`,
  })
  .refine((headers) => Object.keys(headers).every((name) => HTTP_TOKEN_PATTERN.test(name)), {
    message: 'Header names must contain only valid HTTP token characters',
  })
  .refine(
    (headers) => Object.keys(headers).every((name) => !RESERVED_WEBHOOK_HEADER_NAMES.has(name.toLowerCase())),
    { message: 'This header is reserved and cannot be set as a custom header' },
  )
  .refine((headers) => Object.values(headers).every((value) => !/[\r\n]/.test(value)), {
    message: 'Header values must not contain line breaks',
  });

export type WebhookHeaders = z.infer<typeof WebhookHeadersSchema>;

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
