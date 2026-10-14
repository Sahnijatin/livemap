import { listOrders, createOrder } from '../services/orderService';
import { isNonEmpty } from '../lib/validation';

export async function getOrders() {
  return listOrders();
}

export async function postOrder(body: { customer: string; total: number }) {
  if (!isNonEmpty(body.customer)) throw new Error('customer required');
  return createOrder(body.customer, body.total);
}
