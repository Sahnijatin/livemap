import { NextResponse } from 'next/server';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  return NextResponse.json({ id: params.id });
}

// export async function PUT() {}

export const DELETE = async () => new Response(null, { status: 204 });
