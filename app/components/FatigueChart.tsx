"use client";

import { useMemo } from "react";
import {
  binFatigueSeries,
  LOGIC,
  type FatigueSample,
  type WindowSpan,
} from "@/lib/analytics";

type Props = {
  series: FatigueSample[];
  highStress: WindowSpan[];
  offWindows: WindowSpan[];
};

// Overlay of P01 trace + 10-min rolling stdev. Highlights the correlation
// between cumulative-runtime fatigue (high stdev) and weephole-leak risk on
// the HP threads.
export function FatigueChart({ series, highStress, offWindows }: Props) {
  const binned = useMemo(() => binFatigueSeries(series, 240), [series]);

  if (binned.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/40 text-sm text-zinc-500">
        Run the data pipeline to populate the fatigue series.
      </div>
    );
  }

  const W = 1000;
  const H = 240;
  const PAD_X = 36;
  const PAD_Y = 16;

  const ts0 = new Date(binned[0].ts).getTime();
  const ts1 = new Date(binned[binned.length - 1].ts).getTime();
  const span = Math.max(1, ts1 - ts0);

  const x = (t: string) =>
    PAD_X + ((new Date(t).getTime() - ts0) / span) * (W - PAD_X * 2);

  const pMin = 12;
  const pMax = 28;
  const yP = (v: number) =>
    H - PAD_Y - ((v - pMin) / (pMax - pMin)) * (H - PAD_Y * 2);

  const sMax = Math.max(4, ...binned.map((b) => b.stdev));
  const yS = (v: number) =>
    H - PAD_Y - ((v / sMax) * (H - PAD_Y * 2));

  const linePts = binned.map((b) => `${x(b.ts).toFixed(1)},${yP(b.p01).toFixed(1)}`).join(" ");
  const stdPts = binned.map((b) => `${x(b.ts).toFixed(1)},${yS(b.stdev).toFixed(1)}`).join(" ");

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#040a14] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="font-mono uppercase tracking-[0.18em] text-cyan-400">
          Fatigue · P01 (kpsi) vs 10-min σ
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-zinc-400">
          <Legend swatch="bg-cyan-400" label="P01" />
          <Legend swatch="bg-rose-400" label={`σ (${LOGIC.ROLLING_WINDOW_MIN}-min rolling)`} />
          <Legend swatch="bg-amber-500/40" label="High-stress window" />
          <Legend swatch="bg-zinc-700" label="Off / Maintenance" />
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full">
        {/* Active band shading */}
        <rect
          x={PAD_X}
          y={yP(LOGIC.ACTIVE_BAND_HIGH_KPSI)}
          width={W - PAD_X * 2}
          height={yP(LOGIC.ACTIVE_BAND_LOW_KPSI) - yP(LOGIC.ACTIVE_BAND_HIGH_KPSI)}
          fill="#0891b2"
          opacity="0.07"
        />
        <text
          x={W - PAD_X}
          y={yP(LOGIC.ACTIVE_BAND_HIGH_KPSI) - 4}
          fill="#67e8f9"
          fontSize="10"
          textAnchor="end"
          opacity="0.7"
        >
          active band 19–26 kpsi
        </text>

        {/* Off-windows */}
        {offWindows.map((w, i) => (
          <rect
            key={`off-${i}`}
            x={x(w.start)}
            y={PAD_Y}
            width={Math.max(2, x(w.end) - x(w.start))}
            height={H - PAD_Y * 2}
            fill="#475569"
            opacity="0.25"
          />
        ))}

        {/* High-stress windows */}
        {highStress.map((w, i) => (
          <rect
            key={`hs-${i}`}
            x={x(w.start)}
            y={PAD_Y}
            width={Math.max(2, x(w.end) - x(w.start))}
            height={H - PAD_Y * 2}
            fill="#f59e0b"
            opacity="0.18"
          />
        ))}

        {/* P01 line */}
        <polyline
          points={linePts}
          fill="none"
          stroke="#22d3ee"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        {/* Rolling stdev line */}
        <polyline
          points={stdPts}
          fill="none"
          stroke="#fb7185"
          strokeWidth="1.4"
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />

        {/* axes */}
        <line x1={PAD_X} y1={H - PAD_Y} x2={W - PAD_X} y2={H - PAD_Y} stroke="#1f2937" />
        <line x1={PAD_X} y1={PAD_Y} x2={PAD_X} y2={H - PAD_Y} stroke="#1f2937" />
        <text x={PAD_X - 4} y={yP(19)} fontSize="9" textAnchor="end" fill="#64748b">19</text>
        <text x={PAD_X - 4} y={yP(26)} fontSize="9" textAnchor="end" fill="#64748b">26</text>
      </svg>
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
