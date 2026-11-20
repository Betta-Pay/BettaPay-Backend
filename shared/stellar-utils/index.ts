/**
 * Stellar network utilities
 * Provides helpers for interacting with the Stellar blockchain
 */

import { StrKey, Keypair, Asset, Operation, xdr, type OperationType } from '@stellar/stellar-sdk';

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

function assertDecimals(fn: string, decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`${fn}: decimals must be a non-negative integer`);
  }
}

/**
 * Converts a decimal amount string to an integer stroops string.
 *
 * Scaling is done by string digit shifting and BigInt, never `10 ** decimals`
 * floating-point math, so arbitrarily large amounts convert exactly.
 *
 * @throws {TypeError}  If `decimalStr` is not a plain non-negative decimal string.
 * @throws {RangeError} If `decimalStr` has more than `decimals` fractional digits
 *                      (rejected rather than truncated so settlements are never underpaid).
 */
export function toStellarAmount(decimalStr: string, decimals = 7): string {
  assertDecimals('toStellarAmount', decimals);
  // Strict format: one or more digits, optionally followed by a decimal point
  // and one or more digits. Rejects empty strings, negatives, scientific
  // notation, whitespace, and partial decimals like '.5' or '1.'.
  if (!/^\d+(\.\d+)?$/.test(decimalStr)) {
    throw new TypeError('toStellarAmount: input must be a valid numeric string');
  }
  const [whole, frac = ''] = decimalStr.split('.');
  if (frac.length > decimals) {
    throw new RangeError(
      `toStellarAmount: input has ${frac.length} fractional digits but at most ${decimals} are allowed`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0')).toString();
}

/**
 * Converts a stroops integer string to a decimal amount string.
 *
 * Expected format: a non-negative integer string matching `/^\d+$/`
 * (e.g. `"15000000"`, `"1"`, `"0"`). Empty strings, decimal strings,
 * negative numbers, and alpha-numeric values are all rejected.
 *
 * Scaling is done by string digit shifting, so the result is exact for any size.
 *
 * @param stroopsStr - Non-negative integer string representing stroops.
 * @param decimals   - Number of decimal places for the asset (default 7, matching XLM/USDC).
 * @returns The equivalent amount expressed as a decimal string.
 * @throws {TypeError} If `stroopsStr` is not a valid non-negative integer string.
 */
export function fromStellarAmount(stroopsStr: Stroops, decimals = 7): Amount {
  assertDecimals('fromStellarAmount', decimals);
  if (!/^\d+$/.test(stroopsStr)) {
    throw new TypeError('fromStellarAmount: input must be a valid integer string');
  }
  const digits = stroopsStr.padStart(decimals + 1, '0');
  const splitAt = digits.length - decimals;
  const whole = BigInt(digits.slice(0, splitAt)).toString();
  const frac = digits.slice(splitAt).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Formats a stroops integer string as a decimal amount string.
 *
 * @throws {TypeError} If `amount` is not a valid non-negative integer string;
 *                     corrupt amounts are surfaced instead of echoed back.
 */
export function formatAmount(amount: Stroops, decimals: number = 7): Amount {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new TypeError(`formatAmount: invalid stroops amount ${JSON.stringify(amount)}`);
  }
  return fromStellarAmount(amount, decimals);
}

/** Max amount representable on Stellar: int64 stroops. */
const MAX_INT64_STROOPS = (2n ** 63n) - 1n;

function isValidAccountId(address: string): boolean {
  // Payments accept both G… accounts and M… muxed accounts.
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidMed25519PublicKey(address);
}

/**
 * Resolves an asset given either as an `Asset` instance or as a string:
 * `'native'` / `'XLM'` for lumens, or `'CODE:ISSUER'` for issued assets.
 */
function resolveAsset(asset: Asset | string): Asset {
  if (asset instanceof Asset) return asset;
  if (typeof asset !== 'string') throw new Error('asset must be an Asset or a string');
  if (asset === 'native' || asset === 'XLM') return Asset.native();

  const [code, issuer, ...rest] = asset.split(':');
  if (rest.length > 0 || !code || !issuer) {
    throw new Error("asset must be 'native', 'XLM', or 'CODE:ISSUER'");
  }
  if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) throw new Error('asset code must be 1-12 alphanumeric characters');
  if (!validateStellarAddress(issuer)) throw new Error('asset issuer must be a valid Stellar address');
  return new Asset(code, issuer);
}

/**
 * Builds a validated Stellar payment operation (#1089).
 *
 * Inputs are checked up front so bad addresses or amounts fail here with a
 * clear error rather than late at transaction submission.
 *
 * @throws {Error} If source/destination are not valid Stellar addresses, the
 *   asset is malformed, or the amount is not a positive decimal with at most
 *   7 fractional digits.
 */
export function buildPaymentOperation(params: {
  source?: string;
  destination: string;
  asset: Asset | string;
  amount: Amount;
}): xdr.Operation<Operation.Payment> {
  if (params.source !== undefined && !isValidAccountId(params.source)) {
    throw new Error('source must be a valid Stellar address');
  }
  if (typeof params.destination !== 'string' || !isValidAccountId(params.destination)) {
    throw new Error('destination must be a valid Stellar address');
  }
  if (typeof params.amount !== 'string' || !/^\d+(\.\d{1,7})?$/.test(params.amount)) {
    throw new Error('amount must be a decimal string with at most 7 fractional digits');
  }
  const stroops = BigInt(toStellarAmount(params.amount));
  if (stroops <= 0n) throw new Error('amount must be greater than zero');
  if (stroops > MAX_INT64_STROOPS) throw new Error('amount exceeds the maximum Stellar amount');

  return Operation.payment({
    destination: params.destination,
    asset: resolveAsset(params.asset),
    amount: params.amount,
    ...(params.source !== undefined ? { source: params.source } : {}),
  });
}

/** Input accepted by buildSetOptionsOp — thresholds/weights are integers 0–255. */
export interface SetOptionsParams {
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  signer?: { key: string; weight: number };
}

/** Normalized setOptions operation returned by buildSetOptionsOp. */
export interface SetOptionsOperation {
  type: OperationType.SetOptions;
  masterWeight: number | null;
  lowThreshold: number | null;
  medThreshold: number | null;
  highThreshold: number | null;
  signer: { key: string; weight: number } | null;
}

export function buildSetOptionsOp(params: SetOptionsParams): SetOptionsOperation {
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
 *  - text:   UTF-8 encoded byte length must be ≤ 28 and contain no null bytes (\0)
 *  - id:     unsigned 64-bit integer (0 – 2^64-1), no sign, no decimals
 *  - hash:   exactly 64 hexadecimal characters (32 bytes)
 *  - return: exactly 64 hexadecimal characters (32 bytes)
 */
export function validateMemo(type: string, value: string): boolean {
  switch (type) {
    case 'text':
      // Null bytes truncate C-string/XDR consumers, silently changing the memo.
      if (value.includes('\0')) return false;
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
