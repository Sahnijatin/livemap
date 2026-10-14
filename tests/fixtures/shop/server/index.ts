import { getOrders, postOrder } from './routes/orders';

export async function handle(method: string, body?: { customer: string; total: number }) {
  return method === 'GET' ? getOrders() : postOrder(body!);
}
