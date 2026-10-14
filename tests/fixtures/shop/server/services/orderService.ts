import { table, insert, type Row } from '../db';
import { assertPositive } from '../lib/validation';

export async function listOrders(): Promise<Row[]> {
  return table('orders');
}

export async function createOrder(customer: string, total: number): Promise<Row> {
  assertPositive(total);
  return insert('orders', { id: String(Date.now()), customer, total });
}
