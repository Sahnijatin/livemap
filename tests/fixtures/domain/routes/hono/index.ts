import { Hono } from 'hono';
import orders from './orders';

const app = new Hono().basePath('/api');

app.get('/health', (c) => c.text('ok'));
app.on('PURGE', '/cache', purgeCache);
app.on(['PUT', 'PATCH'], '/profile', updateProfile);
app.route('/orders', orders);

export default app;
