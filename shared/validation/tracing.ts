/**
 * Distributed tracing header propagation (Issue #118)
 *
 * Two correlation IDs flow across the service mesh:
 *  - `x-request-id` — identifies a single inbound request (per Fastify genReqId).
 *  - `x-trace-id`   — identifies an end-to-end trace spanning every downstream
 *                     hop. Generated at the gateway edge when absent, otherwise
 *                     accepted from upstream so the whole trace shares one id.
 *
 * `propagateTracingHeaders` copies both onto outgoing inter-service requests;
 * `registerTracing` normalises them on inbound requests and binds them to the
 * request logger so every service logs `requestId` and `traceId`.
 */

import { randomUUID } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACE_ID_HEADER = 'x-trace-id';

type HeaderValue = string | string[] | undefined;
type HeaderBag = Record<string, HeaderValue>;

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface TraceContext {
  requestId: string;
  traceId: string;
}

export const DEFAULT_TRACE_SAMPLE_RATE = 1;

export interface TracingOptions {
  sampleRate?: number;
  random?: () => number;
}

export function resolveTraceSampleRate(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_TRACE_SAMPLE_RATE;
  }

  const rate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1
    ? rate
    : DEFAULT_TRACE_SAMPLE_RATE;
}

export function shouldSampleTrace(
  sampleRate: number,
  random: () => number = Math.random,
): boolean {
  return random() < resolveTraceSampleRate(sampleRate);
}

/**
 * Extract the trace context from incoming headers, generating fresh ids when
 * absent (the gateway edge case). `requestId` and `traceId` are independent so
 * a trace id remains stable across hops while request ids can differ.
 */
export function extractTraceContext(headers: HeaderBag = {}): TraceContext {
  const requestId = firstHeader(headers[REQUEST_ID_HEADER]) || randomUUID();
  const traceId = firstHeader(headers[TRACE_ID_HEADER]) || randomUUID();
  return { requestId, traceId };
}

/**
 * Merge tracing headers extracted from `incomingHeaders` into `outgoingHeaders`
 * for an inter-service HTTP call. Returns a new plain headers object; existing
 * outgoing headers are preserved, and the tracing headers always win.
 */
export function propagateTracingHeaders(
  incomingHeaders: HeaderBag = {},
  outgoingHeaders: Record<string, string> = {},
): Record<string, string> {
  const { requestId, traceId } = extractTraceContext(incomingHeaders);
  return {
    ...outgoingHeaders,
    [REQUEST_ID_HEADER]: requestId,
    [TRACE_ID_HEADER]: traceId,
  };
}

/**
 * Fastify plugin: on every inbound request resolve the trace context, normalise
 * the headers (so downstream `propagateTracingHeaders(request.headers)` is
 * consistent), echo `x-trace-id` back on the response, and bind both ids to the
 * request logger.
 */
export function registerTracing(
  fastify: FastifyInstance,
  options: TracingOptions = {},
): void {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Honour a forwarded request id; otherwise fall back to Fastify's request.id.
    const requestId = firstHeader(request.headers[REQUEST_ID_HEADER]) || request.id;
    const traceId = firstHeader(request.headers[TRACE_ID_HEADER]) || randomUUID();

    request.headers[REQUEST_ID_HEADER] = requestId;
    request.headers[TRACE_ID_HEADER] = traceId;
    (request as FastifyRequest & { traceId: string }).traceId = traceId;

    const routeConfig = request.routeOptions?.config as
      | { traceSampleRate?: unknown }
      | undefined;
    const sampleRate = resolveTraceSampleRate(
      routeConfig?.traceSampleRate ?? options.sampleRate ?? process.env.TRACE_SAMPLE_RATE,
    );
    const sampled = shouldSampleTrace(sampleRate, options.random);
    (request as FastifyRequest & { traceSampled: boolean }).traceSampled = sampled;

    reply.header(TRACE_ID_HEADER, traceId);
    request.log = request.log.child({ requestId, traceId, traceSampled: sampled });
  });
}
