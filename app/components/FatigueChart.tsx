"use client";

import { useMemo } from "react";
import {
  binFatigueSeries,
  LOGIC,
  type FatigueSample,
  type RunRecord,
  type WindowSpan,
} from "@/lib/analytics";

type Props = {
  series: FatigueSample[];
  highStress: WindowSpan[];
  offWindows: WindowSpan[];
  runs?: RunRecord[];
};

// --- constants ---

const BATCH_GAP_MS = 4 * 60 * 60 * 1000; // 4 h — heuristic for run separation

// Alternating batch background fill colours (very low opacity).
const BATCH_PALETTE = [
  "#06b6d4", // cyan
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#8b5cf6", // violet
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f43f5e", // rose
];

const W = 1400;
const H = 300;
const PAD_X = 48;
const PAD_TOP = 24;
const PAD_BOTTOM = 44;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;
const AXIS_Y = PAD_TOP + PLOT_H;
const PLOT_W = W - PAD_X * 2;

const P_MIN = 12;
const P_MAX = 28;

function yP(v: number) {
  return PAD_TOP + ((P_MAX - v) / (P_MAX - P_MIN)) * PLOT_H;
}

// --- batch detection ---

type Batch = {
  /** indices into `active` array */
  startIdx: number;
  endIdx: number;
  startDate: Date;
  endDate: Date;
  label: string;
};

function detectBatches(active: FatigueSample[], runsHint?: RunRecord[]): Batch[] {
  if (active.length === 0) return [];

  // If the pipeline emitted run records, use them for precise boundaries.
  if (runsHint && runsHint.length > 0) {
    return runsHint.map((r) => {
      const start = new Date(r.started_at);
      const end = new Date(r.ended_at);
      const startIdx = active.findIndex((s) => new Date(s.ts) >= start);
      const endIdx = (() => {
        for (let i = active.length - 1; i >= 0; i--) {
          if (new Date(active[i].ts) <= end) return i;
        }
        return startIdx;
      })();
      return {
        startIdx: Math.max(0, startIdx),
        endIdx: Math.max(0, endIdx),
        startDate: start,
        endDate: end,
        label: `Run ${r.run_index + 1}`,
      };
    });
  }

  // Heuristic: group by gap > 4 h.
  const batches: Batch[] = [];
  let batchStart = 0;
  for (let i = 1; i <= active.length; i++) {
    const isLast = i === active.length;
    const gapMs = isLast
      ? Infinity
      : new Date(active[i].ts).getTime() - new Date(active[i - 1].ts).getTime();

    if (gapMs > BATCH_GAP_MS || isLast) {
      const endIdx = i - 1;
      batches.push({
        startIdx: batchStart,
        endIdx,
        startDate: new Date(active[batchStart].ts),
        endDate: new Date(active[endIdx].ts),
        label: `Run ${batches.length + 1}`,
      });
      batchStart = i;
    }
  }
  return batches;
}

function fmtBatchLabel(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTickLabel(ts: number): string {
  const d = new Date(ts);
  const hr = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${hr}:${min}`;
}

// --- component ---

/**
 * Active-only fatigue chart.
 *
 * • Filters the input series to active/high_stress/out_of_band samples only —
 *   no below_active or off-period points are plotted.
 * • Groups consecutive active samples into "batches" (runs) separated by gaps
 *   longer than BATCH_GAP_MS.
 * • Maps each sample to an equal-width index-based x position so every run
 *   measurement takes the same horizontal space regardless of wall-clock duration.
 * • Renders alternating coloured backgrounds, vertical dividers, and per-batch
 *   polylines so the gap between runs is visually obvious.
 *
 * Props `highStress` and `offWindows` are retained for API stability but are no
 * longer used in rendering (status-derived amber shading replaces them).
 */
export function FatigueChart({ series, runs: runsHint }: Props) {
  const active = useMemo(
    () =>
      series.filter(
        (s) =>
          s.status === "active" ||
          s.status === "high_stress" ||
          s.status === "out_of_band",
      ),
    [series],
  );

  const binned = useMemo(() => binFatigueSeries(active, 480), [active]);
  const batches = useMemo(() => detectBatches(binned, runsHint), [binned, runsHint]);

  if (binned.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/40 text-sm text-zinc-500">
        No active-run data yet — run the data pipeline or upload a VantagePoint CSV.
      </div>
    );
  }

  const N = binned.length;

  // Index-based x mapping — every sample gets equal horizontal space.
  const xOf = (idx: number) =>
    N === 1 ? PAD_X + PLOT_W / 2 : PAD_X + (idx / (N - 1)) * PLOT_W;

  const sMax = Math.max(4, ...binned.map((b) => b.stdev));
  const yS = (v: number) => PAD_TOP + ((sMax - v) / sMax) * PLOT_H;

  // Per-batch SVG elements.
  const batchBgs: React.ReactNode[] = [];
  const batchDividers: React.ReactNode[] = [];
  const batchLabels: React.ReactNode[] = [];
  const batchP01Lines: React.ReactNode[] = [];
  const batchStdevLines: React.ReactNode[] = [];
  const batchDots: React.ReactNode[] = [];
  const batchTicks: React.ReactNode[] = [];

  batches.forEach((batch, bi) => {
    const color = BATCH_PALETTE[bi % BATCH_PALETTE.length];
    const x0 = xOf(batch.startIdx);
    const x1 = xOf(batch.endIdx);
    const bgW = Math.max(2, x1 - x0);

    // Background band.
    batchBgs.push(
      <rect
        key={`bg-${bi}`}
        x={x0}
        y={PAD_TOP}
        width={bgW}
        height={PLOT_H}
        fill={color}
        opacity="0.06"
      />,
    );

    // Vertical divider at the START of every batch except the first.
    if (bi > 0) {
      batchDividers.push(
        <line
          key={`div-${bi}`}
          x1={x0}
          y1={PAD_TOP}
          x2={x0}
          y2={AXIS_Y}
          stroke="#52525b"
          strokeWidth="1"
          strokeDasharray="3 2"
        />,
      );
    }

    // Batch label at top of divider (or at plot left for the first batch).
    batchLabels.push(
      <text
        key={`lbl-${bi}`}
        x={x0 + 4}
        y={PAD_TOP + 11}
        fontSize="9"
        fill={color}
        opacity="0.9"
        fontWeight="600"
        letterSpacing="0.06em"
      >
        {batch.label} · {fmtBatchLabel(batch.startDate)}
      </text>,
    );

    // Amber shading for high-stress samples within the batch.
    for (let i = batch.startIdx; i <= batch.endIdx; i++) {
      if (binned[i].status === "high_stress") {
        const xl = i === 0 ? PAD_X : (xOf(i - 1) + xOf(i)) / 2;
        const xr = i === N - 1 ? PAD_X + PLOT_W : (xOf(i) + xOf(i + 1)) / 2;
        batchBgs.push(
          <rect
            key={`hs-${i}`}
            x={xl}
            y={PAD_TOP}
            width={xr - xl}
            height={PLOT_H}
            fill="#f59e0b"
            opacity="0.14"
          />,
        );
      }
    }

    // P01 polyline for this batch.
    const p01pts = binned
      .slice(batch.startIdx, batch.endIdx + 1)
      .map((b, j) => `${xOf(batch.startIdx + j).toFixed(1)},${yP(b.p01).toFixed(1)}`)
      .join(" ");
    batchP01Lines.push(
      <polyline
        key={`p01-${bi}`}
        points={p01pts}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />,
    );

    // Stdev polyline for this batch.
    const stdevPts = binned
      .slice(batch.startIdx, batch.endIdx + 1)
      .map((b, j) => `${xOf(batch.startIdx + j).toFixed(1)},${yS(b.stdev).toFixed(1)}`)
      .join(" ");
    batchStdevLines.push(
      <polyline
        key={`std-${bi}`}
        points={stdevPts}
        fill="none"
        stroke="#fb7185"
        strokeWidth="1.3"
        strokeDasharray="4 3"
        strokeLinejoin="round"
      />,
    );

    // Dots at each data point.
    binned.slice(batch.startIdx, batch.endIdx + 1).forEach((b, j) => {
      const cx = xOf(batch.startIdx + j);
      const cy = yP(b.p01);
      const dotColor =
        b.status === "out_of_band"
          ? "#f43f5e"
          : b.status === "high_stress"
            ? "#f59e0b"
            : "#22d3ee";
      batchDots.push(
        <circle
          key={`dot-${batch.startIdx + j}`}
          cx={cx}
          cy={cy}
          r="2"
          fill={dotColor}
          opacity="0.85"
        />,
      );
    });

    // X-axis tick at start of batch (wall-clock time).
    batchTicks.push(
      <g key={`tick-${bi}`}>
        <line
          x1={x0}
          y1={AXIS_Y}
          x2={x0}
          y2={AXIS_Y + 5}
          stroke="#374151"
          strokeWidth="1"
        />
        <text
          x={x0}
          y={AXIS_Y + 16}
          fontSize="9"
          textAnchor="middle"
          fill="#64748b"
        >
          {fmtTickLabel(batch.startDate.getTime())}
        </text>
      </g>,
    );

    // Extra mid-batch tick for larger batches.
    const batchSize = batch.endIdx - batch.startIdx + 1;
    if (batchSize >= 6) {
      const midIdx = batch.startIdx + Math.floor(batchSize / 2);
      const mx = xOf(midIdx);
      const mt = new Date(binned[midIdx].ts).getTime();
      batchTicks.push(
        <g key={`tick-${bi}-mid`}>
          <line
            x1={mx}
            y1={AXIS_Y}
            x2={mx}
            y2={AXIS_Y + 4}
            stroke="#374151"
            strokeWidth="1"
          />
          <text
            x={mx}
            y={AXIS_Y + 16}
            fontSize="8"
            textAnchor="middle"
            fill="#4b5563"
          >
            {fmtTickLabel(mt)}
          </text>
        </g>,
      );
    }
  });

  // Y axis pressure grid lines.
  const yGridLines = [14, 16, 18, 19, 22, 24, 26].map((kpsi) => (
    <g key={`ygrid-${kpsi}`}>
      <line
        x1={PAD_X}
        y1={yP(kpsi)}
        x2={PAD_X + PLOT_W}
        y2={yP(kpsi)}
        stroke="#18222e"
        strokeWidth="1"
      />
      <text x={PAD_X - 4} y={yP(kpsi) + 3} fontSize="9" textAnchor="end" fill="#4b5563">
        {kpsi}
      </text>
    </g>
  ));

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#040a14] p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div className="font-mono uppercase tracking-[0.18em] text-cyan-400">
            Fatigue · P01 (kpsi) vs 10-min σ
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            Active run time only · off periods removed · {batches.length} run
            {batches.length !== 1 ? "s" : ""} detected
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400">
          <Legend swatch="bg-cyan-400" label="P01" />
          <Legend swatch="bg-rose-400" label={`σ (${LOGIC.ROLLING_WINDOW_MIN}-min rolling)`} />
          <Legend swatch="bg-amber-500/40" label="High-stress" />
          <LegendLine color="#52525b" dashed label="Batch boundary" />
        </div>
      </div>

      {/* Chart */}
      <div className="overflow-x-auto rounded-lg">
        <svg width={W} height={H} className="block" style={{ minWidth: `${W}px` }}>
          {/* Active band hint */}
          <rect
            x={PAD_X}
            y={yP(LOGIC.ACTIVE_BAND_HIGH_KPSI)}
            width={PLOT_W}
            height={yP(LOGIC.ACTIVE_BAND_LOW_KPSI) - yP(LOGIC.ACTIVE_BAND_HIGH_KPSI)}
            fill="#0891b2"
            opacity="0.05"
          />
          <text
            x={PAD_X + PLOT_W - 2}
            y={yP(LOGIC.ACTIVE_BAND_HIGH_KPSI) - 4}
            fill="#67e8f9"
            fontSize="9"
            textAnchor="end"
            opacity="0.5"
          >
            active band {LOGIC.ACTIVE_BAND_LOW_KPSI}–{LOGIC.ACTIVE_BAND_HIGH_KPSI} kpsi
          </text>

          {/* Y grid */}
          {yGridLines}

          {/* Batch backgrounds + high-stress shading */}
          {batchBgs}

          {/* Batch dividers */}
          {batchDividers}

          {/* Batch labels */}
          {batchLabels}

          {/* Stdev traces (below P01 so P01 is on top) */}
          {batchStdevLines}

          {/* P01 traces */}
          {batchP01Lines}

          {/* Data dots */}
          {batchDots}

          {/* Axes */}
          <line x1={PAD_X} y1={AXIS_Y} x2={PAD_X + PLOT_W} y2={AXIS_Y} stroke="#1f2937" strokeWidth="1" />
          <line x1={PAD_X} y1={PAD_TOP} x2={PAD_X} y2={AXIS_Y} stroke="#1f2937" strokeWidth="1" />

          {/* X ticks */}
          {batchTicks}

          {/* X-axis label */}
          <text
            x={PAD_X + PLOT_W / 2}
            y={H - 6}
            fontSize="8"
            textAnchor="middle"
            fill="#374151"
            letterSpacing="0.1em"
          >
            INDEX (each point = one measurement; equal spacing)
          </text>
        </svg>
      </div>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2 w-3 rounded-sm ${swatch}`} />
      {label}
    </span>
  );
}

function LegendLine({
  color,
  dashed,
  label,
}: {
  color: string;
  dashed?: boolean;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="14" height="8" className="shrink-0">
        <line
          x1="0"
          y1="4"
          x2="14"
          y2="4"
          stroke={color}
          strokeWidth="1.5"
          strokeDasharray={dashed ? "3 2" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}
