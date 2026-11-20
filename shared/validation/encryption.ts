/**
 * encryption.ts
 *
 * Secure encryption/decryption utilities with per-encryption salt (#526).
 *
 * Design:
 * ───────
 * - Each encryption generates a fresh random salt (16 bytes)
 * - Salt is used in PBKDF2 key derivation (100,000 iterations, SHA-256)
 * - AES-256-GCM provides authenticated encryption
 * - IV (12 bytes) is randomly generated per encryption
 * - Output format: base64(salt:iv:authTag:ciphertext)
 *
 * Security properties (#526):
 * ──────────────────────────
 * - Different salts ensure identical plaintexts produce different ciphertexts
 * - No metadata leakage from deterministic encryption
 * - Authentication prevents tampering
 * - High iteration count resists brute-force attacks on weak passwords
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16; // 128 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';
const FIELD_KEY_DERIVATION_SALT = 'bettapay:field-encryption:v1';
const MAX_DERIVED_KEY_CACHE_SIZE = 64;

// Per-process random key used solely to index the in-memory derived-key cache
// so raw secret strings are never stored as Map keys (#1066).
const CACHE_LOOKUP_HMAC_KEY = crypto.randomBytes(32);
const derivedKeyCache = new Map<string, Buffer>();
const inFlightKeyDerivations = new Map<string, Promise<Buffer>>();

function pbkdf2Async(
  secret: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  iterations: number,
  keylen: number,
  digest: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(secret, salt, iterations, keylen, digest, (err, derivedKey) => {
      if (err) {
        reject(err);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

/**
 * Encrypts plaintext with a password-derived key.
 *
 * Generates a fresh salt and IV for each call, ensuring that encrypting
 * the same plaintext multiple times produces different ciphertexts (#526).
 *
 * @param plaintext  The string to encrypt
 * @param password   Password used for key derivation (min 8 characters recommended)
 * @returns          Base64-encoded string: salt:iv:authTag:ciphertext
 *
 * @example
 *   const encrypted1 = encrypt('secret data', 'myPassword');
 *   const encrypted2 = encrypt('secret data', 'myPassword');
 *   // encrypted1 !== encrypted2 (different salts produce different outputs)
 */
export function encrypt(plaintext: string, password: string): string {
  // Generate fresh salt for this encryption (#526)
  const salt = crypto.randomBytes(SALT_LENGTH);

  // Derive key from password using PBKDF2
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);

  // Generate random IV (nonce) for GCM
  const iv = crypto.randomBytes(IV_LENGTH);

  // Encrypt with AES-256-GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, 'utf8');
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  // Combine salt, iv, authTag, and ciphertext
  const combined = Buffer.concat([salt, iv, authTag, ciphertext]);

  return combined.toString('base64');
}

/**
 * Decrypts ciphertext that was encrypted with `encrypt()`.
 *
 * Extracts the salt and IV from the encrypted payload and derives the same
 * key to decrypt the data.
 *
 * @param encrypted  Base64-encoded encrypted string from `encrypt()`
 * @param password   The same password used during encryption
 * @returns          Decrypted plaintext string
 * @throws           Error if authentication fails or password is incorrect
 *
 * @example
 *   const encrypted = encrypt('secret data', 'myPassword');
 *   const decrypted = decrypt(encrypted, 'myPassword');
 *   // decrypted === 'secret data'
 */
export function decrypt(encrypted: string, password: string): string {
  // Decode base64
  const combined = Buffer.from(encrypted, 'base64');

  const MIN_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (combined.length < MIN_LENGTH) {
    throw new Error(
      `decrypt: invalid payload — expected at least ${MIN_LENGTH} bytes, got ${combined.length}`,
    );
  }

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  // Derive the same key using extracted salt
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);

  // Decrypt with AES-256-GCM
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext);
  plaintext = Buffer.concat([plaintext, decipher.final()]);

  return plaintext.toString('utf8');
}

/**
 * Verifies that a password can successfully decrypt an encrypted value
 * without returning the plaintext.
 *
 * Useful for password verification flows.
 *
 * @param encrypted  Base64-encoded encrypted string
 * @param password   Password to test
 * @returns          true if password is correct, false otherwise
 */
export function verifyPassword(encrypted: string, password: string): boolean {
  try {
    decrypt(encrypted, password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-blocking equivalent of `encrypt()` that offloads PBKDF2 key derivation
 * to libuv's thread pool via async `crypto.pbkdf2` (#1066).
 */
export async function encryptAsync(plaintext: string, password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, 'utf8');
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);

  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([salt, iv, authTag, ciphertext]);

  return combined.toString('base64');
}

/**
 * Non-blocking equivalent of `decrypt()` that offloads PBKDF2 key derivation
 * to libuv's thread pool via async `crypto.pbkdf2` (#1066).
 */
export async function decryptAsync(encrypted: string, password: string): Promise<string> {
  const combined = Buffer.from(encrypted, 'base64');

  const MIN_LENGTH = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (combined.length < MIN_LENGTH) {
    throw new Error(
      `decrypt: invalid payload — expected at least ${MIN_LENGTH} bytes, got ${combined.length}`,
    );
  }

  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext);
  plaintext = Buffer.concat([plaintext, decipher.final()]);

  return plaintext.toString('utf8');
}

/**
 * Non-blocking equivalent of `verifyPassword()` (#1066).
 */
export async function verifyPasswordAsync(encrypted: string, password: string): Promise<boolean> {
  try {
    await decryptAsync(encrypted, password);
    return true;
  } catch {
    return false;
  }
}

const TAG_LENGTH = 16; // 128-bit authentication tag
const ENCRYPTED_PREFIX = '$enc$v1$';

export const SENSITIVE_FIELDS = new Set([
  'secretHash',
  'secret',
  'privateKey',
  'secretKey',
  // #1067 — webhook signing secrets are credentials like any other: without
  // this entry encryptSensitiveFields/decryptSensitiveFields skipped them and
  // the value moved through the system in plaintext.
  'signingSecret',
]);

function resolveFieldSecretKey(secretKey?: string): string {
  const key = secretKey || process.env.FIELD_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('FIELD_ENCRYPTION_KEY environment variable is missing');
  }
  if (key.length < 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be at least 32 characters long');
  }
  return key;
}

function cacheLookupKey(secret: string): string {
  return crypto.createHmac('sha256', CACHE_LOOKUP_HMAC_KEY).update(secret).digest('hex');
}

function getCachedDerivedKey(lookupKey: string): Buffer | undefined {
  const cached = derivedKeyCache.get(lookupKey);
  if (!cached) {
    return undefined;
  }
  // Refresh LRU recency and return a defensive copy so caller mutations
  // cannot corrupt cached key material.
  derivedKeyCache.delete(lookupKey);
  derivedKeyCache.set(lookupKey, cached);
  return Buffer.from(cached);
}

function setCachedDerivedKey(lookupKey: string, derived: Buffer): void {
  const existing = derivedKeyCache.get(lookupKey);
  if (existing) {
    existing.fill(0);
    derivedKeyCache.delete(lookupKey);
  } else if (derivedKeyCache.size >= MAX_DERIVED_KEY_CACHE_SIZE) {
    const oldestKey = derivedKeyCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestVal = derivedKeyCache.get(oldestKey);
      oldestVal?.fill(0);
      derivedKeyCache.delete(oldestKey);
    }
  }
  derivedKeyCache.set(lookupKey, Buffer.from(derived));
}

/**
 * Zeroes and clears all cached derived field-encryption keys (#1066).
 */
export function clearDerivedKeyCache(): void {
  for (const buf of derivedKeyCache.values()) {
    buf.fill(0);
  }
  derivedKeyCache.clear();
}

/**
 * Derives a 256-bit field-encryption key using PBKDF2-HMAC-SHA256 (100,000
 * iterations) with a domain-separated salt, replacing the weak single-pass
 * SHA-256 derivation. Results are cached in a bounded in-memory LRU cache so
 * repeated encryption/decryption calls avoid blocking the event loop (#1066).
 */
export function deriveKey(secretKey?: string): Buffer {
  const key = resolveFieldSecretKey(secretKey);
  const lookup = cacheLookupKey(key);
  const cached = getCachedDerivedKey(lookup);
  if (cached) {
    return cached;
  }

  const derived = crypto.pbkdf2Sync(
    key,
    FIELD_KEY_DERIVATION_SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST,
  );
  setCachedDerivedKey(lookup, derived);
  return derived;
}

/**
 * Asynchronously derives a 256-bit field-encryption key via non-blocking
 * `crypto.pbkdf2`, sharing the same bounded cache as `deriveKey` (#1066).
 */
export async function deriveKeyAsync(secretKey?: string): Promise<Buffer> {
  const key = resolveFieldSecretKey(secretKey);
  const lookup = cacheLookupKey(key);
  const cached = getCachedDerivedKey(lookup);
  if (cached) {
    return cached;
  }

  const pending = inFlightKeyDerivations.get(lookup);
  if (pending) {
    return Buffer.from(await pending);
  }

  const derivation = pbkdf2Async(
    key,
    FIELD_KEY_DERIVATION_SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    PBKDF2_DIGEST,
  )
    .then((derived) => {
      setCachedDerivedKey(lookup, derived);
      return derived;
    })
    .finally(() => {
      inFlightKeyDerivations.delete(lookup);
    });

  inFlightKeyDerivations.set(lookup, derivation);
  return Buffer.from(await derivation);
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptField(plaintext: string, secretKey?: string): string {
  if (typeof plaintext !== 'string') {
    return plaintext;
  }
  if (isEncrypted(plaintext)) {
    return plaintext;
  }

  const key = deriveKey(secretKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  return `${ENCRYPTED_PREFIX}${payload}`;
}

export function decryptField(ciphertext: string, secretKey?: string): string {
  if (typeof ciphertext !== 'string' || !isEncrypted(ciphertext)) {
    return ciphertext;
  }

  const key = deriveKey(secretKey);
  const payload = ciphertext.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(':');

  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload structure');
  }

  const [ivHex, tagHex, encryptedHex] = parts;

  // #1067 — Buffer.from(x, 'hex') does not throw on malformed input: it stops
  // at the first invalid character (or drops a trailing nibble for odd-length
  // strings) and silently returns a shorter buffer, which then fails later as
  // a confusing "authentication tag mismatch". Reject bad hex up front with a
  // clear error instead.
  const hexSegments: Array<[string, string]> = [
    ['iv', ivHex],
    ['auth tag', tagHex],
    ['ciphertext', encryptedHex],
  ];
  for (const [segment, value] of hexSegments) {
    if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
      throw new Error(
        `Invalid hex encoding in encrypted payload segment: ${segment}`,
      );
    }
  }

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Invalid initialization vector or auth tag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Failed to decrypt field: authentication tag mismatch or corrupted ciphertext');
  }
}

// Only plain objects are walked. Non-plain objects (Date, Prisma Decimal,
// Buffer, class instances) are passed through untouched: spreading them would
// strip their prototypes (e.g. Date -> {}, Decimal -> {d,e,s}) and corrupt
// every API response that contains one. They can never hold sensitive fields.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPrototypePollutionKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

export function encryptSensitiveFields<T>(data: T, secretKey?: string): T {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => encryptSensitiveFields(item, secretKey)) as unknown as T;
  }

  if (!isPlainObject(data)) {
    return data;
  }

  const proto = Object.getPrototypeOf(data);
  const result: Record<string, any> = proto === null ? Object.create(null) : {};

  for (const key of Object.keys(data as Record<string, any>)) {
    if (!Object.hasOwn(data, key) || isPrototypePollutionKey(key)) {
      continue;
    }
    const val = (data as Record<string, any>)[key];
    if (SENSITIVE_FIELDS.has(key) && typeof val === 'string') {
      result[key] = encryptField(val, secretKey);
    } else if (val && typeof val === 'object') {
      result[key] = encryptSensitiveFields(val, secretKey);
    } else {
      result[key] = val;
    }
  }

  return result as T;
}

export function decryptSensitiveFields<T>(data: T, secretKey?: string): T {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => decryptSensitiveFields(item, secretKey)) as unknown as T;
  }

  if (!isPlainObject(data)) {
    return data;
  }

  const proto = Object.getPrototypeOf(data);
  const result: Record<string, any> = proto === null ? Object.create(null) : {};

  for (const key of Object.keys(data as Record<string, any>)) {
    if (!Object.hasOwn(data, key) || isPrototypePollutionKey(key)) {
      continue;
    }
    const val = (data as Record<string, any>)[key];
    if (SENSITIVE_FIELDS.has(key) && typeof val === 'string' && isEncrypted(val)) {
      result[key] = decryptField(val, secretKey);
    } else if (val && typeof val === 'object') {
      result[key] = decryptSensitiveFields(val, secretKey);
    } else {
      result[key] = val;
    }
  }

  return result as T;
}
