import { NextResponse } from "next/server";
import { getLifecycleStore } from "@/lib/lifecycle-store";
import { computeTrendsMetrics } from "@/lib/trends-ingest";
import { parseTrendsText } from "@/lib/trends-ingest-txt";
import { PART_CATALOG } from "@/lib/parts-catalog";
import { predictBatchWithModel } from "@/lib/predict-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 80 * 1024 * 1024;  // 80 MB — big enough for ~6mo of trends

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: `invalid multipart payload: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "form-data must include a `file` field with the trends CSV" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "uploaded file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `file too large (${file.size} bytes, max ${MAX_BYTES})` },
      { status: 413 },
    );
  }

  const fileName = (file as File).name ?? "uploaded.csv";

  const store = getLifecycleStore();

  let parsed;
  try {
    // parseTrendsText sniffs the BOM (UTF-16 LE for VantagePoint exports,
    // UTF-8 otherwise) and normalises delimiters before handing off to the
    // shared CSV pipeline, so .txt and .csv take the same path.
    const buf = await file.arrayBuffer();
    parsed = parseTrendsText(buf);
  } catch (err) {
    return NextResponse.json(
      { error: `trends parse failed: ${(err as Error).message}` },
      { status: 422 },
    );
  }

  let windows;
  try {
    windows = await store.activeLifecycleWindows();
  } catch (err) {
    return NextResponse.json(
      { error: `active lifecycle lookup failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  const result = computeTrendsMetrics(parsed, windows, fileName);

  let applied;
  try {
    applied = await store.applyTrendsIngest({ result, source: `trends:${fileName}` });
  } catch (err) {
    return NextResponse.json(
      { error: `apply failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  // Build a fresh prediction snapshot so the operator sees the impact of the
  // upload immediately, without waiting for the dashboard to re-poll.
  let predictions: Awaited<ReturnType<typeof predictBatchWithModel>> = [];
  try {
    const snap = await store.snapshot();
    const slots = new Map(snap.slots.map((s) => [s.installation_id, s]));
    const latestByInstall = new Map<string, typeof snap.lifecycles[number]>();
    for (const lc of snap.lifecycles) {
      if (lc.archived_at !== null) continue;
      const prev = latestByInstall.get(lc.installation_id);
      if (
        !prev ||
        new Date(lc.installation_date).getTime() >
          new Date(prev.installation_date).getTime()
      ) {
        latestByInstall.set(lc.installation_id, lc);
      }
    }
    const inputs = Array.from(latestByInstall.values()).map((lc) => {
      const slot = slots.get(lc.installation_id);
      const code = slot?.part_code ?? "";
      const catalog = PART_CATALOG[code];
      return {
        installation_id: lc.installation_id,
        part_code: code,
        part_name: catalog?.displayName ?? code,
        active_runtime_minutes: lc.active_runtime_minutes,
        high_stress_minutes: lc.high_stress_minutes,
        cumulative_pressure_stress: lc.cumulative_pressure_stress,
        inferred_failures: lc.inferred_failures,
        expected_mtbf_minutes: catalog?.expectedMtbfMinutes ?? null,
        inspection_threshold_min: catalog?.inspectionThresholdMin ?? null,
        failure_threshold_min: catalog?.failureThresholdMin ?? null,
        installation_date: lc.installation_date,
      };
    });
    predictions = await predictBatchWithModel(inputs);
  } catch {
    // Predictions are best-effort — the ingest already succeeded.
  }

  return NextResponse.json({
    backend: store.backend,
    file: fileName,
    rows_ingested: result.rows_ingested,
    signals_detected: result.signals,
    summary: result.summary,
    lifecycles_updated: applied.lifecycles_updated,
    events_logged: applied.events_logged,
    off_windows: result.off_windows.length,
    high_stress_windows: result.high_stress_windows.length,
    passes_total: result.passes.length,
    valid_passes_total: result.summary.valid_passes_total,
    runs_total: result.runs.length,
    conforming_runs_total: result.summary.conforming_runs_total,
    schedule_anomalies_total: result.schedule_anomalies.length,
    passes_persisted: applied.passes_persisted,
    runs_persisted: applied.runs_persisted,
    schedule_anomalies_logged: applied.schedule_anomalies_logged,
    predictions: predictions.slice(0, 30),
  });
}
