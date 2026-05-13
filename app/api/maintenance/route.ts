import { NextResponse } from "next/server";
import {
  FAILURE_MODES,
  getLifecycleStore,
  type FailureMode,
  type LogMaintenanceInput,
  type MaintenanceEvent,
} from "@/lib/lifecycle-store";

export const dynamic = "force-dynamic";

const ALLOWED_EVENT_TYPES: MaintenanceEvent["event_type"][] = [
  "replace",
  "inspect",
  "clean",
  "reset",
  "off_maintenance",
  "high_stress_window",
  "inspection_alert",
  "failure_alert",
  "failure_observation",
  "data_integrity_alert",
  "pass_detected",
];

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

  const event_type = body.event_type;
  if (
    typeof event_type !== "string" ||
    !ALLOWED_EVENT_TYPES.includes(event_type as MaintenanceEvent["event_type"])
  ) {
    return NextResponse.json(
      { error: `event_type must be one of ${ALLOWED_EVENT_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const failure_mode_raw = body.failure_mode;
  let failure_mode: FailureMode | null = null;
  if (failure_mode_raw !== undefined && failure_mode_raw !== null) {
    if (!isFailureMode(failure_mode_raw)) {
      return NextResponse.json(
        { error: `failure_mode must be one of ${FAILURE_MODES.join(", ")}` },
        { status: 400 },
      );
    }
    failure_mode = failure_mode_raw;
  }

  const input: LogMaintenanceInput = {
    event_type: event_type as MaintenanceEvent["event_type"],
    installation_id:
      typeof body.installation_id === "string" ? body.installation_id : null,
    lifecycle_id:
      typeof body.lifecycle_id === "string" ? body.lifecycle_id : null,
    equipment_id:
      typeof body.equipment_id === "string" ? body.equipment_id : null,
    failure_mode,
    detected_at:
      typeof body.detected_at === "string" ? body.detected_at : undefined,
    ended_at: typeof body.ended_at === "string" ? body.ended_at : null,
    duration_minutes:
      typeof body.duration_minutes === "number" ? body.duration_minutes : null,
    notes: typeof body.notes === "string" ? body.notes : null,
    source: typeof body.source === "string" ? body.source : "manual",
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
