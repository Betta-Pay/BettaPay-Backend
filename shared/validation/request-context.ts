import type { FastifyRequest } from 'fastify';

export interface RequestContext {
  requestId: string;
  traceId: string;
  merchantId?: string;
}

type ContextRequest = FastifyRequest & { requestContext?: RequestContext; traceId?: string };

/** Return the normalized correlation and merchant context for a request. */
export function getRequestContext(request: FastifyRequest): RequestContext {
  const req = request as ContextRequest;
  if (req.requestContext) return req.requestContext;
  const merchantId = ((req as unknown as { user?: { merchantId?: unknown } }).user)?.merchantId;
  const context: RequestContext = {
    requestId: request.id,
    traceId: req.traceId ?? String(request.headers['x-trace-id'] ?? request.id),
    ...(typeof merchantId === 'string' && merchantId ? { merchantId } : {}),
  };
  req.requestContext = context;
  return context;
}

/** Install a request hook that makes context available consistently to handlers. */
export function registerRequestContext(fastify: { addHook: (name: 'onRequest', hook: (request: FastifyRequest) => Promise<void>) => void }): void {
  fastify.addHook('onRequest', async (request) => { getRequestContext(request); });
}
