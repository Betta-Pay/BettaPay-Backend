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
export type Amount = string;
/** Integer Stellar stroop amount encoded as a string, e.g. "15005000000". */
export type Stroops = string;

// Shared API response envelope
export type ApiResponse<T> =
  | { data: T }
  | { error: ErrorResponse };

// Paginated response wrapper
export type PaginatedResponse<T> = {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};
