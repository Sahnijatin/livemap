export function OrderTable({ orders }: { orders: unknown[] }) {
  return (
    <table>
      <tbody>
        {orders.map((o, i) => <tr key={i}><td>{JSON.stringify(o)}</td></tr>)}
      </tbody>
    </table>
  );
}
