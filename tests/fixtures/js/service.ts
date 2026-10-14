export async function createOrder(input: OrderInput): Promise<Order> {
  return db.insert(input);
}

export const listOrders = async (userId: string, status?: Status) => {
  return db.find(userId, status);
};

function helper() {}

export class OrderService {
  private cache = new Map();
  find(id: string) {
    return this.cache.get(id);
  }
  handle = (e: Event) => {
    return e;
  };
}

export interface OrderInput { items: string[] }

export type Status = 'a' | 'b';

export enum Color { Red }

const router = express.Router();
