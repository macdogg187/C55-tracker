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
      ? "text-[#cc3311]"
      : part.health === "watch"
        ? "text-[#c85a10]"
        : "text-[#6ab04c]";

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
      className={`group flex w-full items-center gap-4 border-2 p-4 text-left transition ${
        selected
          ? "border-[#e8a020] bg-[#1c1814] shadow-[0_0_24px_rgba(232,160,32,0.2)]"
          : "border-[#2e2820] bg-[#1c1814] hover:border-[#4a3c28]"
      }`}
    >
      {meter}
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-semibold text-[#f0dfc0]">
          {part.partName}
        </p>
        <p className="font-mono text-[10px] text-[#5a4a38]">
          {part.installationId}
          {part.isConsumable && <span className="ml-1 text-[#c85a10]">· consumable</span>}
          {part.isStructural && <span className="ml-1 text-[#e8a020]">· structural</span>}
        </p>
        <p className="font-mono text-xs text-[#8a7a60]">S/N: {part.serialNumber || "—"}</p>
        <p className="font-mono text-xs text-[#8a7a60]">
          Active: {formatHours(part.granularRuntimeMinutes)} · σ-stress:{" "}
          {formatHours(part.highStressMinutes)}
        </p>
        <div className="flex items-center gap-2">
          <span className={`font-orbitron text-[10px] font-medium uppercase tracking-wider ${stateColor}`}>
            {part.health}
          </span>
          {part.alert && (
            <span className={`px-2 py-0.5 font-orbitron text-[9px] font-semibold uppercase tracking-wider ${
              part.alert === "failure"
                ? "bg-[#cc3311]/20 text-[#ff6644]"
                : "bg-[#c85a10]/20 text-[#e8a020]"
            }`}>
              {part.alert === "failure" ? "Replace Now" : "Inspect Due"}
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
  mtbf: number | null;
  inspection: number | null;
  failure: number | null;
}) {
  const ceiling = failure ?? mtbf ?? null;
  const pct = ceiling != null ? Math.min((runtime / ceiling) * 100, 100) : null;
  const radius = 38;
  const C = 2 * Math.PI * radius;
  const off = C - ((pct ?? 0) / 100) * C;
  const stroke =
    pct == null ? "#2e2820" : pct >= 85 ? "#cc3311" : pct >= 60 ? "#c85a10" : "#e8a020";

  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#2e2820" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="9"
          strokeLinecap="butt"
          strokeDasharray={C}
          strokeDashoffset={off}
          transform="rotate(-90 50 50)"
        />
        {inspection != null && ceiling != null && ceiling > 0 && (
          <InspectionTick angle={(inspection / ceiling) * 360} />
        )}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs font-semibold text-[#f0dfc0]">
        {pct != null ? `${pct.toFixed(0)}%` : "—"}
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
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#e8a020" strokeWidth="2" />;
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
  const fill =
    pct >= 85 ? "bg-[#cc3311]" : pct >= 60 ? "bg-[#c85a10]" : "bg-[#e8a020]";
  return (
    <div className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 border border-[#2e2820] bg-[#0e0c0a] p-2">
      <div className="font-orbitron text-[8px] uppercase tracking-widest text-[#5a4a38]">Life</div>
      <div className="relative h-12 w-3 overflow-hidden bg-[#2e2820]">
        <div
          className={`absolute bottom-0 left-0 right-0 ${fill}`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <div className="font-mono text-xs font-semibold text-[#f0dfc0]">{pct}%</div>
      <div className="font-mono text-[9px] text-[#5a4a38]">{lifeLow}–{lifeHigh} min</div>
    </div>
  );
}
