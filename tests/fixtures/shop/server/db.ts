export interface Row { id: string; [key: string]: unknown }

const tables = new Map<string, Row[]>();

export function table(name: string): Row[] {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name)!;
}

export async function insert(name: string, row: Row): Promise<Row> {
  table(name).push(row);
  return row;
}
