import { Router } from 'express';
import axios from 'axios';
import { listOrders, createOrder, getOrder, requireAuth } from '../handlers/orders';

const orders = Router();
const cache = new Map<string, string>();

orders.get('/orders', listOrders);
orders.post('/orders', requireAuth, createOrder);
orders
  .route('/orders/:id')
  .get(getOrder)
  .delete(async (req, res) => {
    cache.delete(req.params.id);
    res.sendStatus(204);
  });
orders.all('/ping', (req, res) => res.send('pong'));

export async function sync() {
  await axios.get('/remote/orders');
  return cache.get('/orders');
}

export default orders;
