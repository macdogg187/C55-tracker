"use client";

import type { PartStatus } from "@/lib/dashboard-data";

type Props = {
  parts: PartStatus[];
  selectedId: string;
  onSelect: (id: string) => void;
};

const HEALTH_FILL: Record<string, string> = {
  nominal: "#10b981",
  watch: "#f59e0b",
  critical: "#f43f5e",
};

// Group slots by the canonical sequential phase of the production flow.
// Order: Cluster (3 orientations × 5 positions) → Pumps (3 × 4) → Outlet Manifold
// → Homogenizer Head (4 stages) → Transducer.
function groupParts(parts: PartStatus[]) {
  const sorted = [...parts].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
  const phase = (p: PartStatus) =>
    p.zone === "cluster"
      ? `cluster:${p.orientation}`
      : p.zone === "pump"
        ? `pump:${p.orientation}`
        : p.zone === "manifold"
          ? "manifold"
          : p.zone === "homogenizer"
            ? "homogenizer"
            : "instrument";
  const groups: { key: string; label: string; parts: PartStatus[] }[] = [];
  for (const p of sorted) {
    const k = phase(p);
    let g = groups.find((x) => x.key === k);
    if (!g) {
      const label =
        k === "manifold"
          ? "Outlet Manifold"
          : k === "homogenizer"
            ? "Homogenizer Head"
            : k === "instrument"
              ? "Transducer"
              : k.startsWith("cluster")
                ? `${cap(p.orientation)} Inlet Cluster`
                : `${cap(p.orientation)} Pump`;
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
      <div className="flex items-center justify-between text-xs text-zinc-400">
        <span className="font-mono uppercase tracking-[0.18em] text-cyan-400">
          Process Flow · Inlet → Outlet
        </span>
        <span className="text-zinc-500">Click a node to focus its lifecycle.</span>
      </div>

      <div className="flex w-full overflow-x-auto rounded-xl border border-zinc-800 bg-[#040a14] p-4">
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
    <div className="flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/55 px-3 py-2 shadow-inner">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
        {group.label}
      </div>
      <div className="flex flex-col gap-1.5">
        {group.parts.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`group flex min-w-[180px] items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left text-xs transition ${
              selectedId === p.id
                ? "border-cyan-400 bg-cyan-950/40 text-cyan-100 shadow-[0_0_18px_rgba(6,182,212,0.25)]"
                : "border-zinc-800 bg-zinc-950/40 text-zinc-200 hover:border-zinc-600"
            }`}
            title={`${p.installationId} · ${p.partName}`}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{p.partName}</span>
              <span className="font-mono text-[10px] text-zinc-500">
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
          stroke="#0891b2"
          strokeWidth="2"
        />
        <polygon points="20,5 24,11 20,17" fill="#0891b2" />
      </svg>
    </div>
  );
}
