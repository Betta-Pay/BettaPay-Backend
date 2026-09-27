import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { createErrorResponse, ErrorCodes } from "@bettapay/validation";

export const REFRESH_RATE_LIMIT_MAX = 10;
export const REFRESH_RATE_LIMIT_SECONDS = 60;

const AUTH_IP_SCORE_THRESHOLD = 20;
const AUTH_IP_SCORE_TTL_SECONDS = 15 * 60;
const USED_NONCE_TTL_SECONDS = 5 * 60;

function authIpScoreKey(ip: string): string {
  return `auth_ip_score:${ip}`;
}

function revokedJtiKey(jti: string): string {
  return `revoked_jti:${jti}`;
}

function usedNonceKey(nonce: string): string {
  return `used_nonce:${nonce}`;
}

function refreshRateKey(merchantId: string): string {
  return `auth_refresh_rate:${merchantId}`;
}

export interface WalletChallengeInput {
  challenge?: string;
  message?: string;
  nonce?: string;
}

export interface MerchantAuthHelpers {
  signMerchantJwt: (merchantId: string, ownerId: string) => string;
  getAuthIpScore: (ip: string) => Promise<number>;
  enforceAuthIpReputation: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  recordAuthIpFailure: (request: FastifyRequest) => Promise<void>;
  recordAuthIpSuccess: (request: FastifyRequest) => Promise<void>;
  isJtiRevoked: (jti: string) => Promise<boolean>;
  revokeJti: (jti: string, ttlSeconds: number) => Promise<void>;
  incrementRefreshRate: (merchantId: string) => Promise<number>;
  isNonceUsed: (nonce: string) => Promise<boolean>;
  markNonceUsed: (nonce: string) => Promise<boolean>;
  walletChallenge: (d: WalletChallengeInput) => string;
  verifyWalletSignature: (
    address: string,
    challenge: string,
    signature: string,
  ) => boolean;
}

export function createAuthHardening(
  redis: Redis,
  issueJwt: (payload: {
    merchantId: string;
    ownerId: string;
    jti: string;
  }) => string,
): MerchantAuthHelpers {
  function signMerchantJwt(merchantId: string, ownerId: string): string {
    return issueJwt({ merchantId, ownerId, jti: crypto.randomUUID() });
  }

  async function getAuthIpScore(ip: string): Promise<number> {
    return Number((await redis.get(authIpScoreKey(ip))) ?? "0");
  }

  async function updateAuthIpScore(ip: string, delta: number): Promise<number> {
    const key = authIpScoreKey(ip);
    if (delta > 0) {
      const score = await redis.incrby(key, delta);
      await redis.expire(key, AUTH_IP_SCORE_TTL_SECONDS);
      return score;
    }

    const current = Number((await redis.get(key)) ?? "0");
    const next = Math.max(0, current + delta);
    if (next === 0) await redis.del(key);
    else await redis.set(key, String(next), "EX", AUTH_IP_SCORE_TTL_SECONDS);
    return next;
  }

  async function enforceAuthIpReputation(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if ((await getAuthIpScore(request.ip)) >= AUTH_IP_SCORE_THRESHOLD) {
      reply
        .header("Retry-After", "300")
        .code(429)
        .send(
          createErrorResponse(
            ErrorCodes.RATE_LIMITED,
            "Too many failed authentication attempts",
          ),
        );
    }
  }

  async function recordAuthIpFailure(request: FastifyRequest): Promise<void> {
    await updateAuthIpScore(request.ip, 1);
  }

  async function recordAuthIpSuccess(request: FastifyRequest): Promise<void> {
    await updateAuthIpScore(request.ip, -1);
  }

  async function isJtiRevoked(jti: string): Promise<boolean> {
    return (await redis.exists(revokedJtiKey(jti))) > 0;
  }

  async function revokeJti(
    jti: string,
    ttlSeconds: number,
  ): Promise<void> {
    await redis.set(revokedJtiKey(jti), "1", "EX", Math.max(1, Math.floor(ttlSeconds)));
  }

  async function incrementRefreshRate(merchantId: string): Promise<number> {
    const key = refreshRateKey(merchantId);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, REFRESH_RATE_LIMIT_SECONDS);
    return count;
  }

  async function isNonceUsed(nonce: string): Promise<boolean> {
    return (await redis.exists(usedNonceKey(nonce))) > 0;
  }

  async function markNonceUsed(nonce: string): Promise<boolean> {
    const result = await redis.set(
      usedNonceKey(nonce),
      "1",
      "EX",
      USED_NONCE_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  }

  function walletChallenge(d: WalletChallengeInput): string {
    return d.challenge ?? d.message ?? d.nonce ?? "";
  }

  function verifyWalletSignature(
    address: string,
    challenge: string,
    signature: string,
  ): boolean {
    try {
      return Keypair.fromPublicKey(address).verify(
        Buffer.from(challenge, "utf8"),
        Buffer.from(signature, "base64"),
      );
    } catch {
      return false;
    }
  }

  return {
    signMerchantJwt,
    getAuthIpScore,
    enforceAuthIpReputation,
    recordAuthIpFailure,
    recordAuthIpSuccess,
    isJtiRevoked,
    revokeJti,
    incrementRefreshRate,
    isNonceUsed,
    markNonceUsed,
    walletChallenge,
    verifyWalletSignature,
  };
}