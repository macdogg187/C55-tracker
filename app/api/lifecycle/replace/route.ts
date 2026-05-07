import { NextResponse } from "next/server";
import {
  FAILURE_MODES,
  getLifecycleStore,
  type FailureMode,
  type ReplacePartInput,
} from "@/lib/lifecycle-store";

export const dynamic = "force-dynamic";

function isFailureMode(v: unknown): v is FailureMode {
  return typeof v === "string" && (FAILURE_MODES as readonly string[]).includes(v);
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const installation_id = body.installation_id;
  const new_serial = body.new_serial;
  const failure_mode = body.failure_mode;
  const notes = body.notes;
  const timestamp = body.timestamp;

  if (typeof installation_id !== "string" || !installation_id.trim()) {
    return NextResponse.json(
      { error: "installation_id is required" },
      { status: 400 },
    );
  }
  if (typeof new_serial !== "string" || !new_serial.trim()) {
    return NextResponse.json(
      { error: "new_serial is required" },
      { status: 400 },
    );
  }
  if (!isFailureMode(failure_mode)) {
    return NextResponse.json(
      { error: `failure_mode must be one of ${FAILURE_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  const input: ReplacePartInput = {
    installation_id: installation_id.trim(),
    new_serial: new_serial.trim(),
    failure_mode,
    notes: typeof notes === "string" ? notes : undefined,
    timestamp: typeof timestamp === "string" ? timestamp : undefined,
  };

  try {
    const store = getLifecycleStore();
    const result = await store.replacePart(input);
    return NextResponse.json({ backend: store.backend, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
