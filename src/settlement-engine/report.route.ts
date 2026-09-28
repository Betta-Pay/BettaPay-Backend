import { FastifyInstance } from 'fastify';

export default async function (fastify: FastifyInstance) {
  // Fix: Require service token on GET /api/settlements/reconcile/report
  fastify.get(
    '/api/settlements/reconcile/report',
    { preValidation: [fastify.serviceAuth] },
    async (request, reply) => {
      return { status: 'success', report: [] };
    }
  );
}
