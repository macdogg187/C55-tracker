"use client";

import type { PartStatus } from "@/lib/dashboard-data";
import { sealWearFraction } from "@/lib/analytics";

type Props = {
  part: PartStatus;
  selected: boolean;
  onSelect: () => void;
};

function formatHours(min: number) {
  return `${(min / 60).toFixed(1)} h`;
}

export function PartCard({ part, selected, onSelect }: Props) {
  const stateColor =
    part.health === "critical"
      ? "text-rose-300"
      : part.health === "watch"
        ? "text-amber-300"
        : "text-emerald-300";

  const meter = part.isConsumable ? (
    <ConsumableMeter
      runtime={part.granularRuntimeMinutes}
      lifeLow={part.sealLifeLowMin ?? 800}
      lifeHigh={part.sealLifeHighMin ?? 1200}
    />
  ) : (
    <RuntimeGauge
      runtime={part.granularRuntimeMinutes}
      mtbf={part.expectedMtbfMinutes}
      inspection={part.inspectionThresholdMin ?? null}
      failure={part.failureThresholdMin ?? null}
    />
  );

  return (
    <button
      onClick={onSelect}
      className={`group flex w-full items-center gap-4 rounded-xl border p-4 text-left transition ${
        selected
          ? "border-cyan-500 bg-cyan-950/25 shadow-[0_0_35px_rgba(8,145,178,0.25)]"
          : "border-zinc-800 bg-zinc-900/55 hover:border-zinc-600"
      }`}
    >
      {meter}
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-semibold text-zinc-100">
          {part.partName}
        </p>
        <p className="font-mono text-[10px] text-zinc-500">
          {part.installationId}
          {part.isConsumable && <span className="ml-1 text-amber-400">· consumable</span>}
          {part.isStructural && <span className="ml-1 text-cyan-400">· structural</span>}
        </p>
        <p className="text-xs text-zinc-400">S/N: {part.serialNumber || "—"}</p>
        <p className="text-xs text-zinc-300">
          Active: {formatHours(part.granularRuntimeMinutes)} · σ-stress:{" "}
          {formatHours(part.highStressMinutes)}
        </p>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium uppercase tracking-wider ${stateColor}`}>
            {part.health}
          </span>
          {part.alert && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-200">
              {part.alert === "failure" ? "Replace now" : "Inspection due"}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function RuntimeGauge({
  runtime,
  mtbf,
  inspection,
  failure,
}: {
  runtime: number;
  mtbf: number;
  inspection: number | null;
  failure: number | null;
}) {
  const ceiling = failure ?? mtbf;
  const pct = Math.min((runtime / ceiling) * 100, 100);
  const radius = 38;
  const C = 2 * Math.PI * radius;
  const off = C - (pct / 100) * C;
  const stroke =
    pct >= 85 ? "#fb7185" : pct >= 60 ? "#f59e0b" : "#22d3ee";

  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#1f2937" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={off}
          transform="rotate(-90 50 50)"
        />
        {inspection && ceiling > 0 && (
          <InspectionTick angle={(inspection / ceiling) * 360} />
        )}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-semibold text-zinc-200">
        {pct.toFixed(0)}%
      </div>
    </div>
  );
}

function InspectionTick({ angle }: { angle: number }) {
  const rad = ((angle - 90) * Math.PI) / 180;
  const r1 = 28;
  const r2 = 46;
  const x1 = 50 + r1 * Math.cos(rad);
  const y1 = 50 + r1 * Math.sin(rad);
  const x2 = 50 + r2 * Math.cos(rad);
  const y2 = 50 + r2 * Math.sin(rad);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#facc15" strokeWidth="2" />;
}

function ConsumableMeter({
  runtime,
  lifeLow,
  lifeHigh,
}: {
  runtime: number;
  lifeLow: number;
  lifeHigh: number;
}) {
  const wear = sealWearFraction(runtime, lifeLow, lifeHigh);
  const pct = Math.min(100, Math.round(wear * 100));
  const fill = pct >= 85 ? "bg-rose-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg bg-zinc-950 p-2">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Life</div>
      <div className="relative h-12 w-3 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`absolute bottom-0 left-0 right-0 ${fill}`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <div className="text-xs font-semibold text-zinc-200">{pct}%</div>
      <div className="text-[9px] text-zinc-500">{lifeLow}–{lifeHigh} min</div>
    </div>
  );
}
