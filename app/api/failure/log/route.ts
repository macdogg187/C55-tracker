import { NextResponse } from "next/server";
import {
  FAILURE_MODES,
  getLifecycleStore,
  type FailureMode,
  type LogMaintenanceInput,
} from "@/lib/lifecycle-store";

// Report-only failure logging. The lifecycle stays active — this is just an
// operator-observed defect that needs an audit trail (e.g. minor scratches,
// early-warning weep) so the predictor can ingest it later as a positive
// label for training without prematurely archiving the part.
//
// Wire this to ReplacePartDialog (mode="report"). For full replacement use
// /api/lifecycle/replace, which both archives + logs a 'replace' event.

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
  const failure_mode = body.failure_mode;

  if (typeof installation_id !== "string" || !installation_id.trim()) {
    return NextResponse.json(
      { error: "installation_id is required" },
      { status: 400 },
    );
  }
  if (!isFailureMode(failure_mode)) {
    return NextResponse.json(
      { error: `failure_mode must be one of ${FAILURE_MODES.join(", ")}` },
      { status: 400 },
    );
  }

  const input: LogMaintenanceInput = {
    event_type: "failure_observation",
    installation_id: installation_id.trim(),
    equipment_id:
      typeof body.equipment_id === "string" ? body.equipment_id : null,
    failure_mode,
    detected_at:
      typeof body.timestamp === "string" ? body.timestamp : undefined,
    notes: typeof body.notes === "string" && body.notes ? body.notes : null,
    source: "manual",
  };

  try {
    const store = getLifecycleStore();
    const event = await store.logMaintenance(input);
    return NextResponse.json({ backend: store.backend, event });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
