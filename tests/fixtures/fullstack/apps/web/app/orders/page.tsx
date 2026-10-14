async function loadOrders(): Promise<{ id: string; total: number }[]> {
  const res = await fetch(`${process.env.API_URL}/api/orders`, { cache: 'no-store' });
  return res.json();
}

export default async function OrdersPage() {
  const list = await loadOrders();
  return (
    <ul>
      {list.map(o => <li key={o.id}>{o.total}</li>)}
    </ul>
  );
}
