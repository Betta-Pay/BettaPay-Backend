import fp from 'fastify-plugin';

export const serviceAuthPlugin = fp(async (fastify) => {
  // Fix: Register serviceAuth decorator in settlement-engine bootstrap
  fastify.decorate('serviceAuth', async (request, reply) => {
    const token = request.headers['x-service-token'];
    if (!token) {
      reply.code(401).send({ error: 'Missing Service Token' });
    }
  });
});
