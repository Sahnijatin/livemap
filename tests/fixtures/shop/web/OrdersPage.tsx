import { useOrders } from './hooks/useOrders';
import { OrderTable } from './OrderTable';

export function OrdersPage() {
  const orders = useOrders();
  return <OrderTable orders={orders} />;
}
