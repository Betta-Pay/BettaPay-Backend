// Shared Type Definitions for BettaPay — single source of truth for TS types

import type { ErrorResponse } from '@bettapay/validation';
export * from '@bettapay/validation';
export type {
  HealthStatus,
  DependencyConnectionStatus,
  DependencyHealth,
  HealthResponse,
  ServiceHealthSnapshot,
  AggregatedHealthResponse,
} from '@bettapay/validation';

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
export type ID = string;
export type Currency = string;
/** Arbitrary-precision decimal amount encoded as a numeric string, e.g. "1500.50". */
declare const amountBrand: unique symbol;
export type Amount = string & { readonly [amountBrand]: 'Amount' };
export const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
export function isAmount(value: unknown): value is Amount { return typeof value === 'string' && AMOUNT_PATTERN.test(value); }
export function parseAmount(value: string): Amount {
  if (!isAmount(value)) throw new TypeError('Amount must be an unsigned decimal string');
  return value;
}
/** Integer Stellar stroop amount encoded as a string, e.g. "15005000000". */
export type Stroops = string;

// Shared API response envelope
export type ApiResponse<T> =
  | { data: T }
  | { error: ErrorResponse };

// Paginated response wrapper
export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

export type PaginatedResponse<T> = {
  data: T[];
  pagination: PaginationMeta;
};

// Single source of truth for computing pagination metadata so every list
// endpoint (settlements, events, audit log, ...) reports identical semantics.
export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: total > 0 && page < totalPages,
    hasPrev: page > 1,
  };
}
