"use client";

import type { PartStatus } from "@/lib/dashboard-data";
import { sealWearFraction } from "@/lib/analytics";

type Props = {
  part: PartStatus;
  selected: boolean;
  onSelect: () => void;
  onReplace?: () => void;
};

function formatHours(min: number) {
  return `${(min / 60).toFixed(1)} h`;
}

export function PartCard({ part, selected, onSelect, onReplace }: Props) {
  const stateColor =
    part.health === "critical"
      ? "text-[#A82020]"
      : part.health === "watch"
        ? "text-[#B8860B]"
        : "text-[#2B7A3E]";

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
    <div
      className={`group flex w-full items-center gap-4 border p-4 text-left transition-all rounded-sm ${
        selected
          ? "border-[#C04810] bg-[#F0EFE8] shadow-[0_0_0_1px_rgba(212,96,42,0.2)]"
          : "border-[#B0AD9E] bg-[#F0EFE8] hover:border-[#7A7768]"
      }`}
    >
      <button onClick={onSelect} className="flex flex-1 items-center gap-4 text-left">
        {meter}
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-semibold text-[#1A1A16]">
            {part.partName}
          </p>
          <p className="text-[10px] text-[#787870]">
            {part.installationId}
            {part.isConsumable && <span className="ml-1 text-[#B8860B]">· consumable</span>}
            {part.isStructural && <span className="ml-1 text-[#C04810]">· structural</span>}
          </p>
          <p className="text-xs text-[#4A4A42]">S/N: {part.serialNumber || "—"}</p>
          <p className="text-xs text-[#4A4A42]">
            Active: {formatHours(part.granularRuntimeMinutes)} · σ-stress:{" "}
            {formatHours(part.highStressMinutes)}
          </p>
          <div className="flex items-center gap-2">
            <span className={`font-barlow text-[10px] font-medium uppercase tracking-wider ${stateColor}`}>
              {part.health}
            </span>
            {part.alert && (
              <span className={`px-2 py-0.5 font-barlow text-[9px] font-semibold uppercase tracking-wider rounded-sm ${
                part.alert === "failure"
                  ? "bg-[#A82020]/15 text-[#A82020]"
                  : "bg-[#B8860B]/15 text-[#B8860B]"
              }`}>
                {part.alert === "failure" ? "Replace Now" : "Inspect Due"}
              </span>
            )}
          </div>
        </div>
      </button>
      {onReplace && (
        <button
          onClick={(e) => { e.stopPropagation(); onReplace(); }}
          className="shrink-0 border border-[#C04810] bg-[#C04810]/10 px-2.5 py-1.5 font-barlow text-[9px] font-semibold uppercase tracking-wider text-[#C04810] transition hover:bg-[#C04810]/20 rounded-sm"
          title="Replace this part"
        >
          Replace
        </button>
      )}
    </div>
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
    pct == null ? "#B0AD9E" : pct >= 85 ? "#A82020" : pct >= 60 ? "#B8860B" : "#C04810";

  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#B0AD9E" strokeWidth="9" />
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
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-semibold text-[#1A1A16]">
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
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#C04810" strokeWidth="2" />;
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
    pct >= 85 ? "bg-[#A82020]" : pct >= 60 ? "bg-[#B8860B]" : "bg-[#C04810]";
  return (
    <div className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 border border-[#B0AD9E] bg-[#E5E3DA] p-2 rounded-sm">
      <div className="font-barlow text-[8px] uppercase tracking-widest text-[#787870]">Life</div>
      <div className="relative h-12 w-3 overflow-hidden bg-[#B0AD9E] rounded-sm">
        <div
          className={`absolute bottom-0 left-0 right-0 ${fill} rounded-sm`}
          style={{ height: `${pct}%` }}
        />
      </div>
      <div className="text-xs font-semibold text-[#1A1A16]">{pct}%</div>
      <div className="text-[9px] text-[#787870]">{lifeLow}–{lifeHigh} min</div>
    </div>
  );
}
