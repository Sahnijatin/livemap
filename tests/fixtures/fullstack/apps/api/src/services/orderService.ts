import { prisma } from '../db';

export async function findOrders() {
  return prisma.order.findMany({ include: { items: true } });
}

export async function insertOrder(input: { userId: string; total: number }) {
  return prisma.order.create({ data: input });
}

export async function deleteOrder(id: string) {
  await prisma.order.delete({ where: { id } });
}
