"use client";

import { useEffect, useRef, useState } from "react";

type Factor = { label: string; weight: number; detail: string };
type Prediction = {
  installation_id: string;
  part_code: string;
  part_name: string;
  risk_score: number;
  band: "low" | "moderate" | "high" | "critical";
  eta_minutes: number | null;
  factors: Factor[];
  active_runtime_minutes: number;
  failure_threshold_min: number | null;
  expected_mtbf_minutes: number | null;
  source?: "model" | "heuristic";
  predicted_failure_mode?: string;
  predicted_failure_confidence?: number;
  model_ttf_minutes?: number;
};

// Zone membership by part code — mirrors lib/parts-catalog.ts zone assignments.
const ZONE_BY_PART_CODE: Record<string, "cluster" | "pump"> = {
  ICVB: "cluster", HPT: "cluster", OCVB: "cluster",
  ICVBS: "cluster", OCVBS: "cluster", CVBALL: "cluster", SPRING: "cluster",
  PLG: "pump", BUS: "pump", PB: "pump", CVBSPB: "pump",
};

// Canonical row order within each zone (matches SubassemblyGrid ZONE_PART_ORDER).
const CLUSTER_ORDER = ["ICVB", "HPT", "OCVB", "ICVBS", "OCVBS", "CVBALL", "SPRING"];
const PUMP_ORDER    = ["PLG", "BUS", "PB", "CVBSPB"];
// Center-only parts rendered in their own section (no orientation heading).
const CENTER_ORDER  = ["HVB", "CSEAT", "IR", "CSTEM", "OM", "TR"];

// Infer orientation from installation_id slot code.
// Format: {eqId}_{prefix}{zone}{slot} e.g. 0091_LC1, 0091_MP3, 0091_H1, 0091_O, 0091_T
function inferOrientation(id: string): "left" | "middle" | "right" | "center" {
  const slot = id.split("_")[1] ?? "";
  if (slot.startsWith("L")) return "left";
  if (slot.startsWith("R")) return "right";
  if (slot.startsWith("MC") || slot.startsWith("MP")) return "middle";
  return "center";
}

type Response = {
  generated_at: string;
  count: number;
  source?: "model" | "heuristic";
  predictions: Prediction[];
};

type LiveStatus = {
  connected: boolean;
  lastSampleAt: string | null;
  bufferedOnConnect: number | null;
};

type Props = {
  equipmentId: string;
  refreshKey: number;
  onSelect: (installationId: string) => void;
  selectedId?: string | null;
  /** When provided, renders a "Replace →" link on each card using this function. */
  replaceHref?: (installationId: string) => string;
};

const BAND_STYLE: Record<Prediction["band"], string> = {
  low: "border-[#6ab04c]/30 bg-[#6ab04c]/5 text-[#f0dfc0]",
  moderate: "border-[#e8a020]/30 bg-[#e8a020]/5 text-[#f0dfc0]",
  high: "border-[#c85a10]/30 bg-[#c85a10]/5 text-[#f0dfc0]",
  critical: "border-[#cc3311]/30 bg-[#cc3311]/5 text-[#f0dfc0]",
};

const SCORE_COLOR: Record<Prediction["band"], string> = {
  low: "bg-[#6ab04c]",
  moderate: "bg-[#e8a020]",
  high: "bg-[#c85a10]",
  critical: "bg-[#cc3311]",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function PredictionCard({
  p,
  selectedId,
  onSelect,
  replaceHref,
}: {
  p: Prediction;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  replaceHref?: (id: string) => string;
}) {
  return (
    <div
      onClick={() => onSelect(p.installation_id)}
      className={`cursor-pointer border-2 p-3 transition hover:border-[#e8a020] ${BAND_STYLE[p.band]} ${selectedId === p.installation_id ? "border-[#e8a020] shadow-[0_0_16px_rgba(232,160,32,0.2)]" : ""}`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="font-orbitron text-[9px] uppercase tracking-widest text-[#8a7a60]">
            {p.installation_id}
          </p>
          <p className="text-sm font-semibold text-[#f0dfc0]">{p.part_name}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="bg-black/30 px-2 py-1 font-orbitron text-[9px] font-bold uppercase tracking-wider text-[#e8a020]">
            {p.band}
          </span>
          {replaceHref && (
            <a
              href={replaceHref(p.installation_id)}
              onClick={(e) => e.stopPropagation()}
              className="border border-[#e8a020]/60 bg-[#1c1814] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#e8a020] hover:bg-[#2e2820]"
            >
              Replace →
            </a>
          )}
        </div>
      </div>
      <div className="mb-2 h-1.5 w-full overflow-hidden bg-[#2e2820]">
        <div
          className={`h-full ${SCORE_COLOR[p.band]}`}
          style={{ width: `${Math.min(100, p.risk_score)}%` }}
        />
      </div>
      <p className="font-mono text-xs text-[#8a7a60]">
        Score <strong className="text-[#f0dfc0]">{p.risk_score}</strong>
        {p.eta_minutes !== null && (
          <>
            {" · "}ETA{" "}
            <strong className="text-[#f0dfc0]">
              {p.eta_minutes <= 0
                ? "service now"
                : `${p.eta_minutes.toLocaleString()} min`}
            </strong>
          </>
        )}
        {p.predicted_failure_mode && (
          <>
            {" · "}likely{" "}
            <strong className="text-[#e8a020]">{p.predicted_failure_mode}</strong>
            {p.predicted_failure_confidence !== undefined && (
              <span className="text-[#5a4a38]">
                {" ("}
                {Math.round(p.predicted_failure_confidence * 100)}%)
              </span>
            )}
          </>
        )}
      </p>
      {p.factors.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-[11px] leading-tight">
          {p.factors.slice(0, 3).map((f) => (
            <li key={f.label} className="flex items-baseline gap-2 text-[#8a7a60]">
              <span>{f.label}</span>
              <span className="ml-auto">
                {Math.round(f.weight * 100)}%
              </span>
              <span className="block w-full text-[10px] text-[#5a4a38]">{f.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LMRHeader() {
  return (
    <div className="mb-1 grid grid-cols-[160px_1fr_1fr_1fr] gap-3 px-1">
      <div />
      {(["LEFT", "MIDDLE", "RIGHT"] as const).map((o) => (
        <div
          key={o}
          className="text-center font-orbitron text-[10px] font-semibold uppercase tracking-widest text-[#4a3c28]"
        >
          {o}
        </div>
      ))}
    </div>
  );
}

function LMRRow({
  label,
  partCode,
  parts,
  selectedId,
  onSelect,
  replaceHref,
}: {
  label: string;
  partCode: string;
  parts: Prediction[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  replaceHref?: (id: string) => string;
}) {
  return (
    <div className="grid grid-cols-[160px_1fr_1fr_1fr] items-start gap-3">
      <div className="flex flex-col justify-center py-3">
        <p className="font-orbitron text-[10px] font-semibold leading-snug uppercase tracking-wider text-[#f0dfc0]">{label}</p>
        <p className="font-mono text-[10px] text-[#4a3c28]">{partCode}</p>
      </div>
      {(["left", "middle", "right"] as const).map((orient) => {
        const p = parts.find((x) => inferOrientation(x.installation_id) === orient);
        if (!p) {
          return (
            <div
              key={orient}
              className="min-h-[80px] border border-[#2e2820]/40 bg-[#0e0c0a]/20 opacity-25"
            />
          );
        }
        return (
          <PredictionCard
            key={p.installation_id}
            p={p}
            selectedId={selectedId}
            onSelect={onSelect}
            replaceHref={replaceHref}
          />
        );
      })}
    </div>
  );
}

function LMRSection({
  label,
  parts,
  partOrder,
  selectedId,
  onSelect,
  replaceHref,
}: {
  label: string;
  parts: Prediction[];
  partOrder: string[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  replaceHref?: (id: string) => string;
}) {
  const byCode = new Map<string, Prediction[]>();
  for (const p of parts) {
    const arr = byCode.get(p.part_code) ?? [];
    arr.push(p);
    byCode.set(p.part_code, arr);
  }
  const codes = [...byCode.keys()].sort((a, b) => {
    const ai = partOrder.indexOf(a);
    const bi = partOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  if (codes.length === 0) return null;
  return (
    <div>
      <h3 className="mb-3 border-l-2 border-[#e8a020] pl-2 font-orbitron text-xs font-bold uppercase tracking-widest text-[#e8a020]">
        {label}
      </h3>
      <div className="overflow-x-auto">
        <div className="min-w-[680px] space-y-2.5">
          <LMRHeader />
          {codes.map((code) => {
            const ps = byCode.get(code)!;
            return (
              <LMRRow
                key={code}
                label={ps[0].part_name}
                partCode={code}
                parts={ps}
                selectedId={selectedId}
                onSelect={onSelect}
                replaceHref={replaceHref}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CenterSection({
  parts,
  partOrder,
  selectedId,
  onSelect,
  replaceHref,
}: {
  parts: Prediction[];
  partOrder: string[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  replaceHref?: (id: string) => string;
}) {
  if (parts.length === 0) return null;
  const sorted = [...parts].sort((a, b) => {
    const ai = partOrder.indexOf(a.part_code);
    const bi = partOrder.indexOf(b.part_code);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return (
    <div>
      <h3 className="mb-3 border-l-2 border-[#e8a020] pl-2 font-orbitron text-xs font-bold uppercase tracking-widest text-[#e8a020]">
        Homogenizer / Manifold &amp; Instruments
      </h3>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {sorted.map((p) => (
          <PredictionCard
            key={p.installation_id}
            p={p}
            selectedId={selectedId}
            onSelect={onSelect}
            replaceHref={replaceHref}
          />
        ))}
      </div>
    </div>
  );
}

export function FailurePredictionPanel({
  equipmentId,
  refreshKey,
  onSelect,
  selectedId,
  replaceHref,
}: Props) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>({
    connected: false,
    lastSampleAt: null,
    bufferedOnConnect: null,
  });
  const liveSampleCount = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/predictions", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Response;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    // When the live SSE stream is silent, fall back to polling every 12s.
    // When the stream is active, polling drops to 30s because the stream
    // worker triggers fresh predictions on every tumbling-window flush.
    const id = setInterval(load, liveStatus.connected ? 30_000 : 12_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey, liveStatus.connected]);

  // Opportunistic SSE subscription. If the live stream worker isn't running
  // (or the endpoint 404s) we silently fall back to polling — no error UI
  // surfaced because live mode is best-effort.
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    const es = new EventSource("/api/predictions/live");
    es.addEventListener("hello", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { buffered: number };
        setLiveStatus((s) => ({ ...s, connected: true, bufferedOnConnect: payload.buffered }));
      } catch {
        setLiveStatus((s) => ({ ...s, connected: true }));
      }
    });
    es.addEventListener("sample", (e) => {
      liveSampleCount.current += 1;
      try {
        const sample = JSON.parse((e as MessageEvent).data) as { ts: number };
        setLiveStatus((s) => ({ ...s, lastSampleAt: new Date(sample.ts).toISOString() }));
      } catch {
        /* swallow malformed payloads */
      }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; surface the disconnected state but
      // don't tear down the connection — the browser will retry.
      setLiveStatus((s) => ({ ...s, connected: false }));
    };
    return () => {
      es.close();
      setLiveStatus({ connected: false, lastSampleAt: null, bufferedOnConnect: null });
    };
  }, []);

  const filtered = (data?.predictions ?? []).filter((p) =>
    p.installation_id.startsWith(`${equipmentId}_`),
  );

  return (
    <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-orbitron text-sm font-semibold uppercase tracking-widest text-[#e8a020]">Failure Prediction</h2>
          <p className="mt-1 font-mono text-xs text-[#5a4a38]">
            Risk score combines runtime / failure-threshold ratio, high-stress
            exposure, cumulative pressure stress, and inferred off-windows.
          </p>
        </div>
        {data && (
          <div className="flex flex-col items-end gap-1 font-mono text-[11px] text-[#5a4a38]">
            <p>
              {filtered.length} active part{filtered.length === 1 ? "" : "s"} ·{" "}
              updated {new Date(data.generated_at).toLocaleTimeString()}
            </p>
            <p className="flex items-center gap-1">
              <span
                className={
                  liveStatus.connected
                    ? "inline-block h-1.5 w-1.5 bg-[#6ab04c]"
                    : "inline-block h-1.5 w-1.5 bg-[#4a3c28]"
                }
              />
              {liveStatus.connected ? (
                <>
                  Live stream
                  {liveStatus.lastSampleAt && (
                    <span className="text-[#5a4a38]">
                      {" "}
                      · last sample {new Date(liveStatus.lastSampleAt).toLocaleTimeString()}
                    </span>
                  )}
                </>
              ) : (
                <>Polling (live worker offline)</>
              )}
              <span className="mx-1 text-[#4a3c28]">·</span>
              <span
                className={
                  data.source === "model" ? "text-[#e8a020]" : "text-[#5a4a38]"
                }
              >
                {data.source === "model" ? "ML model" : "Heuristic"}
              </span>
            </p>
          </div>
        )}
      </div>

      {loading && !data && (
        <p className="font-mono text-xs text-[#5a4a38]">Computing predictions…</p>
      )}
      {error && (
        <p className="border border-[#cc3311]/60 bg-[#cc3311]/10 px-3 py-2 font-mono text-xs text-[#ff6644]">
          Failed to load predictions: {error}
        </p>
      )}

      {filtered.length === 0 && !loading && !error && (
        <p className="font-mono text-xs text-[#5a4a38]">
          No active lifecycles for {equipmentId} yet. Upload the MTBF tracker to seed
          the database.
        </p>
      )}

      {filtered.length > 0 && (() => {
        const clusterParts = filtered.filter((p) => ZONE_BY_PART_CODE[p.part_code] === "cluster");
        const pumpParts    = filtered.filter((p) => ZONE_BY_PART_CODE[p.part_code] === "pump");
        const centerParts  = filtered.filter((p) => !ZONE_BY_PART_CODE[p.part_code]);
        return (
          <div className="space-y-8">
            <LMRSection
              label="Cluster"
              parts={clusterParts}
              partOrder={CLUSTER_ORDER}
              selectedId={selectedId}
              onSelect={onSelect}
              replaceHref={replaceHref}
            />
            <LMRSection
              label="Pump"
              parts={pumpParts}
              partOrder={PUMP_ORDER}
              selectedId={selectedId}
              onSelect={onSelect}
              replaceHref={replaceHref}
            />
            <CenterSection
              parts={centerParts}
              partOrder={CENTER_ORDER}
              selectedId={selectedId}
              onSelect={onSelect}
              replaceHref={replaceHref}
            />
          </div>
        );
      })()}
    </section>
  );
}
