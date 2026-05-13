"use client";

import type { PartStatus } from "@/lib/dashboard-data";

type Props = {
  parts: PartStatus[];
  selectedId: string;
  onSelect: (id: string) => void;
};

const HEALTH_FILL: Record<string, string> = {
  nominal: "#6ab04c",
  watch: "#c85a10",
  critical: "#cc3311",
};

// Group slots by the canonical sequential phase of the production flow.
// Order: Cluster (3 orientations × 5 positions) → Pumps (3 × 4) → Outlet Manifold
// → Homogenizing Valve section (HVB → Ceramic Seat → Impact Ring → Ceramic Stem → Transducer).
function groupParts(parts: PartStatus[]) {
  const sorted = [...parts].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  const phase = (p: PartStatus) =>
    p.zone === "cluster"
      ? `cluster:${p.orientation}`
      : p.zone === "pump"
        ? `pump:${p.orientation}`
        : p.zone === "manifold"
          ? "manifold"
          : "homogenizer"; // instrument zone (Transducer) merges into homogenizer section
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

export function SequentialFlowchart({ parts, selectedId, onSelect }: Props) {
  const groups = groupParts(parts);

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-orbitron uppercase tracking-[0.18em] text-[#e8a020]">
          Process Flow · Inlet → Outlet
        </span>
        <span className="font-mono text-[#5a4a38]">Click a node to focus its lifecycle.</span>
      </div>

      <div className="flex w-full overflow-x-auto border-2 border-[#2e2820] bg-[#1c1814] p-4">
        <div className="flex min-w-max items-stretch gap-3">
          {groups.map((g, i) => (
            <div key={g.key} className="flex items-stretch gap-3">
              <FlowGroup group={g} selectedId={selectedId} onSelect={onSelect} />
              {i < groups.length - 1 && <FlowArrow />}
            </div>
          ))}
        </div>
      </div>
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
    <div className="flex flex-col border border-[#2e2820] bg-[#0e0c0a] px-3 py-2">
      <div className="mb-2 font-orbitron text-[10px] font-semibold uppercase tracking-widest text-[#4a3c28]">
        {group.label}
      </div>
      <div className="flex flex-col gap-1.5">
        {group.parts.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`group flex min-w-[180px] items-center justify-between gap-3 border px-2.5 py-1.5 text-left text-xs transition ${
              selectedId === p.id
                ? "border-[#e8a020] bg-[#2e2820] text-[#f0dfc0] shadow-[0_0_12px_rgba(232,160,32,0.2)]"
                : "border-[#2e2820] bg-[#1c1814] text-[#8a7a60] hover:border-[#4a3c28]"
            }`}
            title={`${p.installationId} · ${p.partName}`}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[#f0dfc0]">{p.partName}</span>
              <span className="font-mono text-[10px] text-[#4a3c28]">
                {p.installationId}
              </span>
            </div>
            <span
              className="h-2.5 w-2.5 shrink-0"
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
          stroke="#e8a020"
          strokeWidth="2"
        />
        <polygon points="20,5 24,11 20,17" fill="#e8a020" />
      </svg>
    </div>
  );
}
