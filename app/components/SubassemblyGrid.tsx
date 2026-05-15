"use client";

import { PartCard } from "./PartCard";
import type { PartStatus } from "@/lib/dashboard-data";

type Props = {
  parts: PartStatus[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  onReplace?: (part: PartStatus) => void;
  title: string;
  subtitle?: string;
  sortByPct?: boolean;
};

const ZONE_PART_ORDER: Record<string, string[]> = {
  cluster:     ["ICVB", "HPT", "OCVB", "ICVBS", "OCVBS", "CVBALL", "SPRING"],
  pump:        ["PLG", "BUS", "PB", "CVBSPB"],
  homogenizer: ["HVB", "CSEAT", "IR", "CSTEM"],
  manifold:    ["OM"],
  instrument:  ["TR"],
};

const ORIENTATION_ORDER = ["left", "middle", "right", "center"] as const;
type Orientation = (typeof ORIENTATION_ORDER)[number];

function wearPct(p: PartStatus): number | null {
  const ceiling = p.failureThresholdMin ?? p.expectedMtbfMinutes ?? null;
  if (ceiling == null) return null;
  return p.granularRuntimeMinutes / Math.max(1, ceiling);
}

function sortByOrientation(ps: PartStatus[]): PartStatus[] {
  return [...ps].sort((a, b) => {
    const ai = ORIENTATION_ORDER.indexOf(a.orientation as Orientation);
    const bi = ORIENTATION_ORDER.indexOf(b.orientation as Orientation);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

function LMRRow({
  label,
  partCode,
  parts,
  selectedId,
  onSelect,
  onDeselect,
  onReplace,
}: {
  label: string;
  partCode: string;
  parts: PartStatus[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  onReplace?: (part: PartStatus) => void;
}) {
  const sorted = sortByOrientation(parts);
  const isCenter = sorted.every((p) => p.orientation === "center");

  if (isCenter) {
    const p = sorted[0];
    if (!p) return null;
    return (
      <div className="grid grid-cols-[160px_1fr_1fr_1fr] items-start gap-3">
        <RowLabel label={label} code={partCode} />
        <PartCard
          part={p}
          selected={selectedId === p.id}
          onSelect={() => onSelect(p.id)}
          onDeselect={onDeselect}
          onReplace={onReplace ? () => onReplace(p) : undefined}
        />
        <div />
        <div />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[160px_1fr_1fr_1fr] items-start gap-3">
      <RowLabel label={label} code={partCode} />
      {(["left", "middle", "right"] as const).map((orient) => {
        const p = sorted.find((x) => x.orientation === orient);
        if (!p) {
          return (
            <div
              key={orient}
              className="min-h-[100px] border border-[#B0AD9E]/40 bg-[#E5E3DA]/30 opacity-25 rounded-sm"
            />
          );
        }
        return (
          <PartCard
            key={p.id}
            part={p}
            selected={selectedId === p.id}
            onSelect={() => onSelect(p.id)}
            onDeselect={onDeselect}
            onReplace={onReplace ? () => onReplace(p) : undefined}
          />
        );
      })}
    </div>
  );
}

function RowLabel({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex flex-col justify-center py-3">
      <p className="font-barlow text-[10px] font-semibold uppercase leading-snug tracking-wider text-[#1A1A16]">{label}</p>
      <p className="text-[10px] text-[#7A7768]">{code}</p>
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
          className="text-center font-barlow text-[10px] font-semibold uppercase tracking-[0.25em] text-[#7A7768]"
        >
          {o}
        </div>
      ))}
    </div>
  );
}

function LMRSection({
  parts,
  partCodeOrder,
  selectedId,
  onSelect,
  onDeselect,
  onReplace,
}: {
  parts: PartStatus[];
  partCodeOrder: string[];
  selectedId: string;
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  onReplace?: (part: PartStatus) => void;
}) {
  const byCode = new Map<string, PartStatus[]>();
  for (const p of parts) {
    const arr = byCode.get(p.partCode) ?? [];
    arr.push(p);
    byCode.set(p.partCode, arr);
  }

  const codes = [...byCode.keys()].sort((a, b) => {
    const ai = partCodeOrder.indexOf(a);
    const bi = partCodeOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[680px] space-y-2.5">
        <LMRHeader />
        {codes.map((code) => {
          const ps = byCode.get(code)!;
          return (
            <LMRRow
              key={code}
              label={ps[0].partName}
              partCode={code}
              parts={ps}
              selectedId={selectedId}
              onSelect={onSelect}
              onDeselect={onDeselect}
              onReplace={onReplace}
            />
          );
        })}
      </div>
    </div>
  );
}

export function SubassemblyGrid({
  parts,
  selectedId,
  onSelect,
  onDeselect,
  onReplace,
  title,
  subtitle,
  sortByPct = false,
}: Props) {
  if (sortByPct) {
    const byCode = new Map<string, PartStatus[]>();
    for (const p of parts) {
      const arr = byCode.get(p.partCode) ?? [];
      arr.push(p);
      byCode.set(p.partCode, arr);
    }

    const rows = [...byCode.entries()]
      .map(([code, ps]) => ({
        code,
        parts: ps,
        maxPct: Math.max(...ps.map((p) => wearPct(p) ?? 0)),
      }))
      .sort((a, b) => b.maxPct - a.maxPct);

    const lmrRows    = rows.filter((r) => r.parts.some((p) => p.orientation !== "center"));
    const centerRows = rows.filter((r) => r.parts.every((p) => p.orientation === "center"));

    return (
      <section className="border border-[#B0AD9E] bg-[#F0EFE8] p-5 rounded-sm shadow-sm">
        <SectionHeader title={title} subtitle={subtitle} />
        <div className="space-y-6">
          {lmrRows.length > 0 && (
            <div className="overflow-x-auto">
              <div className="min-w-[680px] space-y-2.5">
                <LMRHeader />
                {lmrRows.map(({ code, parts: ps }) => (
                  <LMRRow
                    key={code}
                    label={ps[0].partName}
                    partCode={code}
                    parts={ps}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    onDeselect={onDeselect}
                    onReplace={onReplace}
                  />
                ))}
              </div>
            </div>
          )}
          {centerRows.length > 0 && (
            <div>
              <h3 className="mb-3 border-l-2 border-[#C04810] pl-2 font-barlow text-xs font-bold uppercase tracking-widest text-[#C04810]">
                Manifold &amp; Instruments
              </h3>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {centerRows.map(({ parts: ps }) =>
                  sortByOrientation(ps).map((p) => (
                    <PartCard
                      key={p.id}
                      part={p}
                      selected={selectedId === p.id}
                      onSelect={() => onSelect(p.id)}
                      onDeselect={onDeselect}
                      onReplace={onReplace ? () => onReplace(p) : undefined}
                    />
                  )),
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }

  const byZone = new Map<string, PartStatus[]>();
  for (const p of parts) {
    const arr = byZone.get(p.zone) ?? [];
    arr.push(p);
    byZone.set(p.zone, arr);
  }

  const manifoldParts = [
    ...(byZone.get("manifold") ?? []),
    ...(byZone.get("instrument") ?? []),
  ];

  const clusterParts  = byZone.get("cluster") ?? [];
  const pumpParts     = byZone.get("pump") ?? [];
  const homogenizerParts = byZone.get("homogenizer") ?? [];

  const sections = [
    { key: "cluster",     label: "Cluster",     parts: clusterParts,    order: ZONE_PART_ORDER.cluster },
    { key: "pump",        label: "Pump",         parts: pumpParts,       order: ZONE_PART_ORDER.pump },
    { key: "homogenizer", label: "Homogenizer",  parts: homogenizerParts, order: ZONE_PART_ORDER.homogenizer },
    { key: "manifold",    label: "Manifold & Instruments", parts: manifoldParts, order: [...ZONE_PART_ORDER.manifold, ...ZONE_PART_ORDER.instrument] },
  ].filter((s) => s.parts.length > 0);

  return (
    <section className="border border-[#B0AD9E] bg-[#F0EFE8] p-5 rounded-sm shadow-sm">
      <SectionHeader title={title} subtitle={subtitle} />
      <div className="space-y-8">
        {sections.map((sec) => {
          const hasLMR = sec.parts.some(
            (p) => p.orientation === "left" || p.orientation === "middle" || p.orientation === "right",
          );

          return (
            <div key={sec.key}>
              <h3 className="mb-3 border-l-2 border-[#C04810] pl-2 font-barlow text-xs font-bold uppercase tracking-widest text-[#C04810]">
                {sec.label}
              </h3>

              {hasLMR ? (
                <LMRSection
                  parts={sec.parts}
                  partCodeOrder={sec.order}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onDeselect={onDeselect}
                  onReplace={onReplace}
                />
              ) : (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {sortByOrientation(sec.parts)
                    .sort((a, b) => {
                      const ai = sec.order.indexOf(a.partCode);
                      const bi = sec.order.indexOf(b.partCode);
                      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
                    })
                    .map((p) => (
                      <PartCard
                        key={p.id}
                        part={p}
                        selected={selectedId === p.id}
                        onSelect={() => onSelect(p.id)}
                        onDeselect={onDeselect}
                        onReplace={onReplace ? () => onReplace(p) : undefined}
                      />
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <h2 className="font-barlow text-sm font-semibold uppercase tracking-widest text-[#C04810]">{title}</h2>
      {subtitle && <p className="text-xs text-[#787870]">{subtitle}</p>}
    </div>
  );
}
