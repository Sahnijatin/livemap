import { Router, type Request, type Response } from 'express';
import { findOrders, insertOrder, deleteOrder } from '../services/orderService';

const router = Router();

async function listOrders(_req: Request, res: Response) {
  res.json(await findOrders());
}

async function createOrder(req: Request, res: Response) {
  res.status(201).json(await insertOrder(req.body));
}

async function removeOrder(req: Request, res: Response) {
  await deleteOrder(req.params.id);
  res.status(204).end();
}

router.get('/orders', listOrders);
router.post('/orders', createOrder);

export default router;
