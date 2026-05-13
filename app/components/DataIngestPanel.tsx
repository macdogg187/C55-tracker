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
    <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-orbitron text-xs uppercase tracking-[0.24em] text-[#e8a020]">Data Ingest</p>
          <h2 className="mt-1 text-sm font-semibold text-[#f0dfc0]">
            Upload tracker &amp; trends — database refreshes in place
          </h2>
          <p className="mt-1 font-mono text-xs text-[#5a4a38]">
            <strong className="text-[#8a7a60]">Tracker (.xlsx)</strong> seeds equipment / slots / lifecycles.{" "}
            <strong className="text-[#8a7a60]">Trends (.csv)</strong> recomputes active runtime, high-stress
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
        <p className="mt-3 border border-[#cc3311]/60 bg-[#cc3311]/10 px-3 py-2 font-mono text-xs text-[#ff6644]">
          {status.channel.toUpperCase()} UPLOAD FAILED: {status.message}
        </p>
      )}
      {status.kind === "uploading" && (
        <p className="mt-3 font-mono text-xs text-[#e8a020]">Uploading {status.channel}…</p>
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
    <div className="flex flex-col gap-2 border border-[#2e2820] bg-[#0e0c0a] p-4">
      <p className="font-orbitron text-xs uppercase tracking-wider text-[#f0dfc0]">{label}</p>
      <p className="font-mono text-xs text-[#5a4a38]">{hint}</p>
      <label className="mt-1 inline-flex w-fit cursor-pointer items-center gap-2 border border-[#e8a020] bg-[#1c1814] px-3 py-1.5 font-mono text-xs font-semibold text-[#e8a020] transition hover:bg-[#2e2820]">
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
        {busy ? "UPLOADING…" : buttonText.toUpperCase()}
      </label>
    </div>
  );
}

function TrackerSummary({ data }: { data: TrackerResponse }) {
  return (
    <div className="mt-3 border border-[#6ab04c]/30 bg-[#6ab04c]/5 p-3 font-mono text-xs text-[#f0dfc0]">
      <p className="font-medium text-[#6ab04c]">
        TRACKER INGESTED · {data.file} → {data.backend}
      </p>
      <p className="mt-1">
        Equipment: <strong>{data.equipment_upserted}</strong> · Slots:{" "}
        <strong>{data.slots_upserted}</strong> · Lifecycles upserted:{" "}
        <strong>{data.lifecycles_upserted}</strong>{" "}
        ({data.lifecycles_inserted} inserted, {data.lifecycles_updated} updated).
      </p>
      <p className="mt-1 text-[#8a7a60]">
        Source rows: {data.report.rows_total} ·{" "}
        skipped_no_install={data.report.skipped_no_install} ·{" "}
        skipped_bad_id={data.report.skipped_bad_id} ·{" "}
        skipped_no_install_date={data.report.skipped_no_install_date ?? 0} ·{" "}
        name_mismatches={data.report.name_mismatches} ·{" "}
        unknown_failure_modes={data.report.unknown_failure_modes}
      </p>
      <p className="mt-1 text-[#5a4a38]">
        Incomplete payloads (imported anyway):
        missing_serial={data.report.missing_serial_number ?? 0} ·{" "}
        missing_runtime={data.report.missing_runtime ?? 0} ·{" "}
        closed_without_failure_mode={data.report.missing_failure_mode_for_closed ?? 0}
      </p>
      {data.report.warnings.length > 0 && (
        <details className="mt-2 text-[#f0dfc0]">
          <summary className="cursor-pointer text-[#6ab04c]">
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
    <div className="mt-3 border border-[#e8a020]/30 bg-[#e8a020]/5 p-3 font-mono text-xs text-[#f0dfc0]">
      <p className="font-medium text-[#e8a020]">
        TRENDS INGESTED · {data.file} → {data.backend}
      </p>
      <p className="mt-1">
        {data.rows_ingested.toLocaleString()} samples · signals:{" "}
        <span className="font-mono text-[#8a7a60]">{data.signals_detected.join(", ")}</span> ·{" "}
        sample period {data.summary.sample_minutes.toFixed(2)} min
      </p>
      <p className="mt-1 text-[#8a7a60]">
        Active: <strong className="text-[#f0dfc0]">{data.summary.active_minutes_total} min</strong> ·{" "}
        High-stress: <strong className="text-[#c85a10]">{data.summary.high_stress_minutes_total} min</strong> ·{" "}
        Off / maint: <strong className="text-[#f0dfc0]">{data.summary.off_minutes_total} min</strong> ·{" "}
        Out-of-band: <strong className="text-[#cc3311]">{data.summary.out_of_band_minutes} min</strong>
      </p>
      <p className="mt-1 text-[#8a7a60]">
        Updated <strong className="text-[#f0dfc0]">{data.lifecycles_updated}</strong> lifecycles, logged{" "}
        <strong className="text-[#f0dfc0]">{data.events_logged}</strong> events
        ({data.high_stress_windows} high-stress + {data.off_windows} off-maintenance windows).
      </p>
      <p className="mt-1 text-[#8a7a60]">
        Passes: <strong className="text-[#f0dfc0]">{data.passes_total ?? 0}</strong>{" "}
        ({data.valid_passes_total ?? 0} valid 36–40 min) ·{" "}
        Runs: <strong className="text-[#f0dfc0]">{data.runs_total ?? 0}</strong>{" "}
        ({data.conforming_runs_total ?? 0} conforming to 10/6-pass cadence) ·{" "}
        Schedule anomalies:{" "}
        <strong
          className={
            (data.schedule_anomalies_total ?? 0) > 0 ? "text-[#c85a10]" : "text-[#f0dfc0]"
          }
        >
          {data.schedule_anomalies_total ?? 0}
        </strong>
      </p>
      {data.predictions.length > 0 && (
        <p className="mt-1 text-[#8a7a60]">
          Top risk: <span className="text-[#e8a020]">{data.predictions[0].installation_id}</span>{" "}
          ({data.predictions[0].part_name}) — risk{" "}
          <strong className="text-[#f0dfc0]">{data.predictions[0].risk_score}</strong>,{" "}
          band {data.predictions[0].band}. See Failure Prediction panel below.
        </p>
      )}
    </div>
  );
}
