import { NextResponse } from "next/server";
import { getLifecycleStore } from "@/lib/lifecycle-store";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const store = getLifecycleStore();
  try {
    const snapshot = await store.snapshot();
    return NextResponse.json({ backend: store.backend, ...snapshot });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
