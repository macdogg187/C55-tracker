"use client";

import type { PartStatus } from "@/lib/dashboard-data";

type Props = {
  parts: PartStatus[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDeselect?: () => void;
};

const HEALTH_FILL: Record<string, string> = {
  nominal: "#2B7A3E",
  watch: "#B8860B",
  critical: "#A82020",
};

function groupParts(parts: PartStatus[]) {
  const sorted = [...parts].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  const phase = (p: PartStatus) =>
    p.zone === "cluster"
      ? `cluster:${p.orientation}`
      : p.zone === "pump"
        ? `pump:${p.orientation}`
        : p.zone === "manifold"
          ? "manifold"
          : "homogenizer";
  const groups: { key: string; label: string; parts: PartStatus[] }[] = [];
  for (const p of sorted) {
    const k = phase(p);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      const label =
        k === "manifold"
          ? "Outlet Manifold"
          : k === "homogenizer"
            ? "Homogenizing Valve"
            : k.startsWith("cluster")
              ? `${cap(p.orientation)} Check Valve Subassembly`
              : `${cap(p.orientation)} Pump Body`;
      g = { key: k, label, parts: [] };
      groups.push(g);
    }
    g.parts.push(p);
  }
  return groups;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatHours(min: number) {
  return `${(min / 60).toFixed(1)} h`;
}

export function SequentialFlowchart({ parts, selectedId, onSelect, onDeselect }: Props) {
  const groups = groupParts(parts);
  const selectedPart = parts.find((p) => p.id === selectedId);

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-barlow uppercase tracking-[0.18em] text-[#C04810]">
          Process Flow · Inlet → Outlet
        </span>
        <span className="text-[#787870]">Click a node to view details.</span>
      </div>

      <div className="flex w-full overflow-x-auto border border-[#B0AD9E] bg-[#E5E3DA] p-4 rounded-sm">
        <div className="flex min-w-max items-stretch gap-3">
          {groups.map((g, i) => (
            <div key={g.key} className="flex items-stretch gap-3">
              <FlowGroup group={g} selectedId={selectedId} onSelect={onSelect} />
              {i < groups.length - 1 && <FlowArrow />}
            </div>
          ))}
        </div>
      </div>

      {/* Inline detail strip — appears below the flowchart when a node is selected */}
      {selectedPart && (
        <div className="flex flex-col gap-2 border border-[#B0AD9E] bg-[#E5E3DA] px-4 py-3 rounded-sm">
          <div className="flex items-center justify-between">
            <span className="font-barlow text-[10px] font-semibold uppercase tracking-widest text-[#C04810]">
              {selectedPart.partName} — {selectedPart.installationId}
            </span>
            {onDeselect && (
              <button
                onClick={onDeselect}
                className="flex h-5 w-5 items-center justify-center rounded-sm border border-[#B0AD9E] bg-[#F0EFE8] text-xs text-[#4A4A42] hover:bg-[#E5E3DA] hover:text-[#1A1A16] transition"
                title="Close details"
              >
                ×
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-4">
            <FlowDetailRow label="Serial" value={selectedPart.serialNumber || "—"} />
            <FlowDetailRow label="Active Runtime" value={formatHours(selectedPart.granularRuntimeMinutes)} />
            <FlowDetailRow label="High-Stress" value={formatHours(selectedPart.highStressMinutes)} />
            <FlowDetailRow
              label="Health"
              value={selectedPart.health}
              accent={selectedPart.health === "critical" ? "text-[#A82020]" : selectedPart.health === "watch" ? "text-[#B8860B]" : "text-[#2B7A3E]"}
            />
            {selectedPart.expectedMtbfMinutes && (
              <FlowDetailRow label="Expected MTBF" value={formatHours(selectedPart.expectedMtbfMinutes)} />
            )}
            {selectedPart.inspectionThresholdMin && (
              <FlowDetailRow label="Inspection At" value={formatHours(selectedPart.inspectionThresholdMin)} />
            )}
            {selectedPart.failureThresholdMin && (
              <FlowDetailRow label="Failure At" value={formatHours(selectedPart.failureThresholdMin)} />
            )}
            {selectedPart.alert && (
              <FlowDetailRow
                label="Alert"
                value={selectedPart.alert === "failure" ? "Replace Now" : "Inspect Due"}
                accent={selectedPart.alert === "failure" ? "text-[#A82020]" : "text-[#B8860B]"}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FlowDetailRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[#7A7768]">{label}</span>
      <span className={`font-medium ${accent ?? "text-[#1A1A16]"}`}>{value}</span>
    </div>
  );
}

function FlowGroup({
  group,
  selectedId,
  onSelect,
}: {
  group: { key: string; label: string; parts: PartStatus[] };
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col border border-[#B0AD9E] bg-[#FAFAF5] px-3 py-2 rounded-sm">
      <div className="mb-2 font-barlow text-[10px] font-semibold uppercase tracking-widest text-[#7A7768]">
        {group.label}
      </div>
      <div className="flex flex-col gap-1.5">
        {group.parts.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`group flex min-w-[180px] items-center justify-between gap-3 border-l-4 px-2.5 py-1.5 text-left text-xs transition-all rounded-sm ${
              selectedId === p.id
                ? "border-l-[#C04810] border-t-[#B0AD9E] border-r-[#B0AD9E] border-b-[#B0AD9E] bg-[#FAF5EE] text-[#1A1A16] shadow-sm"
                : "border-l-transparent border-[#B0AD9E] bg-[#F0EFE8] text-[#4A4A42] hover:border-l-[#C04810]/40 hover:border-[#7A7768]"
            }`}
            title={`${p.installationId} · ${p.partName}`}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[#1A1A16]">{p.partName}</span>
              <span className="text-[10px] text-[#7A7768]">
                {p.installationId}
              </span>
            </div>
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: HEALTH_FILL[p.health] }}
              aria-label={p.health}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex items-center justify-center">
      <svg width="24" height="22" viewBox="0 0 24 22">
        <line
          x1="0"
          y1="11"
          x2="20"
          y2="11"
          stroke="#C04810"
          strokeWidth="2"
        />
        <polygon points="20,5 24,11 20,17" fill="#C04810" />
      </svg>
    </div>
  );
}
