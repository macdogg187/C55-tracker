"use client";

import { useRef, useState } from "react";

type TrackerResponse = {
  backend: "supabase" | "local-json";
  file: string;
  sheet: string;
  equipment_upserted: number;
  slots_upserted: number;
  lifecycles_upserted: number;
  lifecycles_inserted: number;
  lifecycles_updated: number;
  report: {
    rows_total: number;
    lifecycles_imported: number;
    skipped_no_install: number;
    skipped_bad_id: number;
    skipped_no_install_date?: number;
    missing_serial_number?: number;
    missing_runtime?: number;
    missing_failure_mode_for_closed?: number;
    name_mismatches: number;
    unknown_failure_modes: number;
    warnings: string[];
    fatal?: string | null;
  };
};

type TrendsResponse = {
  backend: "supabase" | "local-json";
  file: string;
  rows_ingested: number;
  signals_detected: string[];
  summary: {
    active_minutes_total: number;
    high_stress_minutes_total: number;
    off_minutes_total: number;
    out_of_band_minutes: number;
    pulsation_threshold_kpsi: number;
    gap_off_minutes: number;
    sample_minutes: number;
    passes_total?: number;
    valid_passes_total?: number;
    pass_runtime_minutes_total?: number;
    runs_total?: number;
    conforming_runs_total?: number;
    schedule_anomalies_total?: number;
  };
  lifecycles_updated: number;
  events_logged: number;
  off_windows: number;
  high_stress_windows: number;
  passes_total?: number;
  valid_passes_total?: number;
  runs_total?: number;
  conforming_runs_total?: number;
  schedule_anomalies_total?: number;
  passes_persisted?: number;
  runs_persisted?: number;
  schedule_anomalies_logged?: number;
  predictions: {
    installation_id: string;
    part_name: string;
    band: string;
    risk_score: number;
  }[];
};

type Status =
  | { kind: "idle" }
  | { kind: "uploading"; channel: "tracker" | "trends" }
  | { kind: "ok"; channel: "tracker"; data: TrackerResponse }
  | { kind: "ok"; channel: "trends"; data: TrendsResponse }
  | { kind: "error"; channel: "tracker" | "trends"; message: string };

type Props = {
  onIngest: () => Promise<void>;
};

export function DataIngestPanel({ onIngest }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const trackerRef = useRef<HTMLInputElement | null>(null);
  const trendsRef = useRef<HTMLInputElement | null>(null);

  async function upload(channel: "tracker" | "trends", file: File) {
    setStatus({ kind: "uploading", channel });
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`/api/ingest/${channel}`, { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setStatus({
          kind: "error",
          channel,
          message: (json as { error?: string }).error ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (channel === "tracker") {
        setStatus({ kind: "ok", channel: "tracker", data: json as TrackerResponse });
      } else {
        setStatus({ kind: "ok", channel: "trends", data: json as TrendsResponse });
      }
      await onIngest();
    } catch (err) {
      setStatus({ kind: "error", channel, message: (err as Error).message });
    }
  }

  return (
    <section className="rounded-2xl border border-cyan-900/40 bg-gradient-to-b from-slate-900 to-[#04080f] p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-400">Data ingest</p>
          <h2 className="text-base font-semibold text-zinc-100">
            Upload tracker & trends — the database refreshes in place
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            <strong>Tracker (.xlsx)</strong> seeds equipment / slots / lifecycles.{" "}
            <strong>Trends (.csv)</strong> recomputes active runtime, high-stress
            exposure, and failure-risk predictions for every active part.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <UploadCard
          label="MTBF Tracker workbook"
          hint="Accepts the legacy MTBF Tracker .xlsx (Tracker sheet)."
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          buttonText="Choose .xlsx"
          busy={status.kind === "uploading" && status.channel === "tracker"}
          inputRef={trackerRef}
          onFile={(f) => upload("tracker", f)}
        />
        <UploadCard
          label="VantagePoint trends CSV / TXT"
          hint="Pressure, flow, RPM and temp samples (P01 column required). UTF-16 LE auto-decoded."
          accept=".csv,text/csv,.txt,text/plain"
          buttonText="Choose .csv / .txt"
          busy={status.kind === "uploading" && status.channel === "trends"}
          inputRef={trendsRef}
          onFile={(f) => upload("trends", f)}
        />
      </div>

      {status.kind === "error" && (
        <p className="mt-3 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
          {status.channel} upload failed: {status.message}
        </p>
      )}
      {status.kind === "uploading" && (
        <p className="mt-3 text-xs text-cyan-200/80">Uploading {status.channel}…</p>
      )}
      {status.kind === "ok" && status.channel === "tracker" && (
        <TrackerSummary data={status.data} />
      )}
      {status.kind === "ok" && status.channel === "trends" && (
        <TrendsSummary data={status.data} />
      )}
    </section>
  );
}

function UploadCard({
  label,
  hint,
  accept,
  buttonText,
  busy,
  inputRef,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  buttonText: string;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/30 p-4">
      <p className="text-sm font-semibold text-zinc-100">{label}</p>
      <p className="text-xs text-zinc-400">{hint}</p>
      <label className="mt-1 inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-cyan-700/60 bg-cyan-900/30 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-700/40">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
        {busy ? "Uploading…" : buttonText}
      </label>
    </div>
  );
}

function TrackerSummary({ data }: { data: TrackerResponse }) {
  return (
    <div className="mt-3 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-3 text-xs text-emerald-100">
      <p className="font-medium text-emerald-300">
        Tracker ingested · {data.file} → {data.backend}
      </p>
      <p className="mt-1">
        Equipment: <strong>{data.equipment_upserted}</strong> · Slots:{" "}
        <strong>{data.slots_upserted}</strong> · Lifecycles upserted:{" "}
        <strong>{data.lifecycles_upserted}</strong>{" "}
        ({data.lifecycles_inserted} inserted, {data.lifecycles_updated} updated).
      </p>
      <p className="mt-1 text-emerald-200/80">
        Source rows: {data.report.rows_total} ·{" "}
        skipped_no_install={data.report.skipped_no_install} ·{" "}
        skipped_bad_id={data.report.skipped_bad_id} ·{" "}
        skipped_no_install_date={data.report.skipped_no_install_date ?? 0} ·{" "}
        name_mismatches={data.report.name_mismatches} ·{" "}
        unknown_failure_modes={data.report.unknown_failure_modes}
      </p>
      <p className="mt-1 text-emerald-200/70">
        Incomplete payloads (imported anyway):
        missing_serial={data.report.missing_serial_number ?? 0} ·{" "}
        missing_runtime={data.report.missing_runtime ?? 0} ·{" "}
        closed_without_failure_mode={data.report.missing_failure_mode_for_closed ?? 0}
      </p>
      {data.report.warnings.length > 0 && (
        <details className="mt-2 text-emerald-100/90">
          <summary className="cursor-pointer text-emerald-300">
            {data.report.warnings.length} warning{data.report.warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 max-h-40 overflow-auto pl-4">
            {data.report.warnings.slice(0, 100).map((w, i) => (
              <li key={i} className="font-mono text-[10px]">
                {w}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TrendsSummary({ data }: { data: TrendsResponse }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-900/45 bg-amber-950/15 p-3 text-xs text-amber-100">
      <p className="font-medium text-amber-300">
        Trends ingested · {data.file} → {data.backend}
      </p>
      <p className="mt-1">
        {data.rows_ingested.toLocaleString()} samples · signals:{" "}
        <span className="font-mono">{data.signals_detected.join(", ")}</span> ·{" "}
        sample period {data.summary.sample_minutes.toFixed(2)} min
      </p>
      <p className="mt-1 text-amber-200/85">
        Active: <strong>{data.summary.active_minutes_total} min</strong> ·{" "}
        High-stress: <strong>{data.summary.high_stress_minutes_total} min</strong> ·{" "}
        Off / maint: <strong>{data.summary.off_minutes_total} min</strong> ·{" "}
        Out-of-band: <strong>{data.summary.out_of_band_minutes} min</strong>
      </p>
      <p className="mt-1 text-amber-200/85">
        Updated <strong>{data.lifecycles_updated}</strong> lifecycles, logged{" "}
        <strong>{data.events_logged}</strong> events
        ({data.high_stress_windows} high-stress + {data.off_windows} off-maintenance windows).
      </p>
      <p className="mt-1 text-amber-200/85">
        Passes: <strong>{data.passes_total ?? 0}</strong>{" "}
        ({data.valid_passes_total ?? 0} valid 36–40 min) ·{" "}
        Runs: <strong>{data.runs_total ?? 0}</strong>{" "}
        ({data.conforming_runs_total ?? 0} conforming to 10/6-pass cadence) ·{" "}
        Schedule anomalies:{" "}
        <strong
          className={
            (data.schedule_anomalies_total ?? 0) > 0 ? "text-orange-300" : ""
          }
        >
          {data.schedule_anomalies_total ?? 0}
        </strong>
      </p>
      {data.predictions.length > 0 && (
        <p className="mt-1 text-amber-200/80">
          Top risk: <span className="font-mono">{data.predictions[0].installation_id}</span>{" "}
          ({data.predictions[0].part_name}) — risk{" "}
          <strong>{data.predictions[0].risk_score}</strong>,{" "}
          band {data.predictions[0].band}. See Failure Prediction panel below.
        </p>
      )}
    </div>
  );
}
