/**
 * Stellar network utilities
 * Provides helpers for interacting with the Stellar blockchain
 */

import { StrKey, Keypair } from '@stellar/stellar-sdk';

type Amount = string;
type Stroops = string;
export enum StellarNetwork { PUBLIC = 'public', TESTNET = 'testnet', FUTURENET = 'futurenet' }
const HORIZON_URLS: Record<StellarNetwork, string> = {
  [StellarNetwork.PUBLIC]: 'https://horizon.stellar.org',
  [StellarNetwork.TESTNET]: 'https://horizon-testnet.stellar.org',
  [StellarNetwork.FUTURENET]: 'https://horizon-futurenet.stellar.org',
};
export type MemoType = 'text' | 'id' | 'hash' | 'return';

export function validateStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}
export const validateStellarPublicKey = validateStellarAddress;

export function validateTransactionHash(hash: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Generate a random Ed25519 Stellar keypair.
 *
 * The returned `secretKey` is the master seed and **must** be stored
 * securely (e.g. encrypted at rest, environment variable, or secret
 * manager). It must **never** be logged, included in error messages,
 * or sent over unencrypted channels.
 *
 * @returns An object with `publicKey` (G…) and `secretKey` (S…).
 */
export function generateStellarKeypair(): { publicKey: string; secretKey: string } {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

// Convert decimal string to stroops (string of integer stroops)
export function toStellarAmount(decimalStr: string, decimals = 7): string {
  // Strict format: one or more digits, optionally followed by a decimal point
  // and one or more digits. Rejects empty strings, negatives, scientific
  // notation, whitespace, and partial decimals like '.5' or '1.'.
  if (!/^\d+(\.\d+)?$/.test(decimalStr)) {
    throw new TypeError('toStellarAmount: input must be a valid numeric string');
  }
  // naive conversion: multiply decimal by 10^decimals
  const [whole, frac = ''] = decimalStr.split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const stroops = BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(paddedFrac || '0');
  return stroops.toString();
}

/**
 * Converts a stroops integer string to a decimal amount string.
 *
 * Expected format: a non-negative integer string matching `/^\d+$/`
 * (e.g. `"15000000"`, `"1"`, `"0"`). Empty strings, decimal strings,
 * negative numbers, and alpha-numeric values are all rejected.
 *
 * @param stroopsStr - Non-negative integer string representing stroops.
 * @param decimals   - Number of decimal places for the asset (default 7, matching XLM/USDC).
 * @returns The equivalent amount expressed as a decimal string.
 * @throws {TypeError} If `stroopsStr` is not a valid non-negative integer string.
 */
export function fromStellarAmount(stroopsStr: Stroops, decimals = 7): Amount {
  if (!/^\d+$/.test(stroopsStr)) {
    throw new TypeError('fromStellarAmount: input must be a valid integer string');
  }
  const n = BigInt(stroopsStr);
  const whole = n / BigInt(10 ** decimals);
  const frac = (n % BigInt(10 ** decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

export function formatAmount(amount: Stroops, decimals: number = 7): Amount {
  // Provided for backwards compatibility: expects stroops input
  try {
    return fromStellarAmount(amount, decimals);
  } catch {
    return amount;
  }
}

export function buildPaymentOperation(params: { source?: string; destination: string; asset: string; amount: Amount }){
  // Placeholder: return normalized operation object
  return {
    type: 'payment',
    source: params.source || null,
    destination: params.destination,
    asset: params.asset,
    amount: params.amount
  };
}

export function buildSetOptionsOp(params: any) {
  if (params.masterWeight !== undefined) {
    if (!Number.isInteger(params.masterWeight) || params.masterWeight < 0 || params.masterWeight > 255) throw new Error('masterWeight must be an integer between 0 and 255');
  }
  if (params.lowThreshold !== undefined) {
    if (!Number.isInteger(params.lowThreshold) || params.lowThreshold < 0 || params.lowThreshold > 255) throw new Error('lowThreshold must be an integer between 0 and 255');
  }
  if (params.medThreshold !== undefined) {
    if (!Number.isInteger(params.medThreshold) || params.medThreshold < 0 || params.medThreshold > 255) throw new Error('medThreshold must be an integer between 0 and 255');
  }
  if (params.highThreshold !== undefined) {
    if (!Number.isInteger(params.highThreshold) || params.highThreshold < 0 || params.highThreshold > 255) throw new Error('highThreshold must be an integer between 0 and 255');
  }
  if (params.signer) {
    if (!validateStellarAddress(params.signer.key)) throw new Error('signer.key must be a valid Stellar address');
    if (!Number.isInteger(params.signer.weight) || params.signer.weight < 0 || params.signer.weight > 255) throw new Error('signer.weight must be an integer between 0 and 255');
  }

  return {
    type: 'setOptions',
    masterWeight: params.masterWeight ?? null,
    lowThreshold: params.lowThreshold ?? null,
    medThreshold: params.medThreshold ?? null,
    highThreshold: params.highThreshold ?? null,
    signer: params.signer ?? null
  };
}

const UINT64_MAX = (2n ** 64n) - 1n;
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

/**
 * Validates a Stellar transaction memo field.
 *
 * @param type  One of: "text" | "id" | "hash" | "return"
 * @param value The memo value as a string
 * @returns     true if the value is valid for the given type, false otherwise
 *
 * Validation rules:
 *  - text:   UTF-8 encoded byte length must be ≤ 28
 *  - id:     unsigned 64-bit integer (0 – 2^64-1), no sign, no decimals
 *  - hash:   exactly 64 hexadecimal characters (32 bytes)
 *  - return: exactly 64 hexadecimal characters (32 bytes)
 */
export function validateMemo(type: string, value: string): boolean {
  switch (type) {
    case 'text':
      return Buffer.byteLength(value, 'utf8') <= 28;

    case 'id': {
      if (!/^\d+$/.test(value)) return false;
      try {
        const n = BigInt(value);
        return n >= 0n && n <= UINT64_MAX;
      } catch {
        return false;
      }
    }

    case 'hash':
    case 'return':
      return HEX_32_BYTES.test(value);

    default:
      return false;
  }
}

export function buildMemo(type: MemoType, value: string): { type: MemoType; value: string } {
  if (!validateMemo(type, value)) throw new TypeError(`Invalid Stellar ${type} memo`);
  return { type, value };
}

/**
 * Builds a properly encoded Horizon API URL for the specified resource.
 * Handles trailing slashes in base URL and encodes query parameters.
 *
 * @param baseUrl - The Horizon API base URL (e.g., 'https://horizon.stellar.org' or 'https://horizon.stellar.org/')
 * @param resource - The Horizon resource path (e.g., 'accounts', 'transactions', 'operations', 'payments', 'effects')
 * @param params - Optional query parameters to include in the URL
 * @returns The fully constructed URL string
 *
 * @example
 * // Basic resource URL
 * buildHorizonUrl('https://horizon.stellar.org', 'accounts');
 * // Returns: 'https://horizon.stellar.org/accounts'
 *
 * @example
 * // With query parameters
 * buildHorizonUrl('https://horizon.stellar.org', 'transactions', { limit: 10, order: 'desc' });
 * // Returns: 'https://horizon.stellar.org/transactions?limit=10&order=desc'
 *
 * @example
 * // With trailing slash in base URL
 * buildHorizonUrl('https://horizon.stellar.org/', 'payments', { asset: 'USD:GABC...' });
 * // Returns: 'https://horizon.stellar.org/payments?asset=USD%3AGABC...'
 *
 * @example
 * // Special characters are encoded
 * buildHorizonUrl('https://horizon.stellar.org', 'accounts', { signer: 'GABC... =DEF' });
 * // Returns: 'https://horizon.stellar.org/accounts?signer=GABC...%20%3DDEF'
 */
export function buildHorizonUrl(
  baseUrl: string,
  resource: string,
  params?: Record<string, any>
): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = new URL(`${normalizedBase}/${resource}`);

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    url.search = searchParams.toString();
  }

  return url.toString();
}

export function horizonUrlBuilder(network: StellarNetwork, resource: string, params?: Record<string, unknown>): string {
  if (!Object.values(StellarNetwork).includes(network)) throw new TypeError(`Unsupported Stellar network: ${String(network)}`);
  return buildHorizonUrl(HORIZON_URLS[network], resource, params);
}
