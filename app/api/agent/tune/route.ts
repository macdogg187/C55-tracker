import "server-only";
import { NextResponse } from "next/server";
import { runParamTuner, type TunerTrigger } from "@/lib/agent-param-tuner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// =============================================================================
// POST /api/agent/tune
//
// Triggers the agentic parameter-tuning loop. The agent:
//   1. Reads all closed lifecycles with known failure modes
//   2. Compares observed failure runtimes against current thresholds
//   3. Generates parameter proposals with justifications
//   4. Applies medium/high-confidence proposals and logs the change
//   5. Returns the full proposal list (applied + pending human review)
//
// Request body (all optional):
//   {
//     "trigger":      "trends_upload" | "part_replacement" | "manual_review",
//     "dry_run":      true,        // propose but do not apply or log
//     "equipment_id": "0091"       // scope to one machine
//   }
// =============================================================================

export async function POST(req: Request) {
  let body: {
    trigger?: TunerTrigger;
    dry_run?: boolean;
    equipment_id?: string;
  } = {};

  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const trigger: TunerTrigger = body.trigger ?? "manual_review";
  const validTriggers: TunerTrigger[] = ["trends_upload", "part_replacement", "manual_review"];
  if (!validTriggers.includes(trigger)) {
    return NextResponse.json(
      { error: `trigger must be one of: ${validTriggers.join(", ")}` },
      { status: 422 },
    );
  }

  try {
    const result = await runParamTuner(trigger, {
      dry_run: body.dry_run ?? false,
      equipment_id: body.equipment_id,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
