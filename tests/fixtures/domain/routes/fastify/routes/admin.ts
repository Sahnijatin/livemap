import type { FastifyInstance } from 'fastify';

export default async function admin(fastify: FastifyInstance) {
  fastify.get('/stats', async () => ({ ok: true }));
  fastify.delete('/cache/:key', clearCache);
}
