import Fastify from 'fastify';
import { listItems } from './handlers';

const server = Fastify({ logger: true });

server.get('/items', listItems);
server.route({
  method: ['GET', 'HEAD'],
  url: '/items/:id',
  handler: async (req, reply) => reply.send({ id: req.params }),
});
server.route({ method: 'POST', url: '/items', handler: createItem });

server.register(import('./routes/admin'), { prefix: '/admin' });
server.register(users, { prefix: '/users' });

server.listen({ port: 3000 });
