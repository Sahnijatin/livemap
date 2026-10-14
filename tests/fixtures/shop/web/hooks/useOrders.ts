import { useEffect, useState } from 'react';

export function useOrders() {
  const [orders, setOrders] = useState<unknown[]>([]);
  useEffect(() => {
    fetch('/api/orders').then(r => r.json()).then(setOrders);
  }, []);
  return orders;
}
