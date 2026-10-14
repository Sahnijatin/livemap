import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => json({ id: params.id });

export async function PATCH({ request }) {
  return json(await request.json());
}
