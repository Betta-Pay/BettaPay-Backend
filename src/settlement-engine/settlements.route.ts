import { FastifyInstance } from 'fastify';

export default async function (fastify: FastifyInstance) {
  // Fix: Require service token on GET /api/settlements
  fastify.get(
    '/api/settlements',
    { preValidation: [fastify.serviceAuth] },
    async (request, reply) => {
      return { status: 'success', data: [] };
    }
  );

  // Fix: Require service token on POST /api/settlements
  fastify.post(
    '/api/settlements',
    { preValidation: [fastify.serviceAuth] },
    async (request, reply) => {
      return { status: 'created' };
    }
  );

  // Fix: Require service token on POST /api/settlements/:id/retry
  fastify.post(
    '/api/settlements/:id/retry',
    { preValidation: [fastify.serviceAuth] },
    async (request, reply) => {
      return { status: 'retrying' };
    }
  );

  // Fix: Require service token on GET /api/settlements/reconcile
  fastify.get(
    '/api/settlements/reconcile',
    { preValidation: [fastify.serviceAuth] },
    async (request, reply) => {
      return { status: 'reconciled' };
    }
  );
}
