"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  HistogramSeries,
  CrosshairMode,
  type UTCTimestamp,
  type IChartApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import { LOGIC, type FatigueSample } from "@/lib/analytics";

type Props = {
  series: FatigueSample[];
};

type SlopePoint = {
  /** Fake UTCTimestamp = cumulativeRuntimeSeconds, used as x-axis value. */
  fakeTime: UTCTimestamp;
  cumulativeMin: number;
  maxSlope: number;   // worst-case rising dT/dt across T01/T02/T03 (°C/min)
  slopeT01: number;
  slopeT02: number;
  slopeT03: number;
};

/**
 * Compute sample-to-sample rising temperature slopes during active P01 windows.
 *
 * X-axis: cumulative active runtime minutes (re-mapped to fake UTCTimestamp so
 *   lightweight-charts can use its time scale). Gaps ≥ gap_off_min are skipped
 *   but the cumulative counter keeps increasing so chart times stay sorted.
 * Y-axis: max(0, dT/dt) across T01/T02/T03, in °C/min.
 */
function computeSlopePoints(series: FatigueSample[]): SlopePoint[] {
  const ACTIVE = new Set(["active", "high_stress", "out_of_band"]);
  const GAP_MIN = LOGIC.GAP_OFF_MIN;

  const active = series.filter(
    (s) => ACTIVE.has(s.status) && (s.t01 != null || s.t02 != null || s.t03 != null),
  );

  if (active.length < 2) return [];

  const points: SlopePoint[] = [];
  let cumulativeMin = 0;

  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const curr = active[i];
    const dtMin = (new Date(curr.ts).getTime() - new Date(prev.ts).getTime()) / 60_000;

    if (dtMin <= 0) continue;

    // Gaps ≥ gap_off_min indicate a machine-off period — skip the pair but
    // do NOT reset cumulativeMin. Resetting caused fakeTime to go backwards
    // (later points got smaller timestamps than earlier ones), which crashed
    // lightweight-charts' strict ascending-time assertion on setData.
    if (dtMin > GAP_MIN) {
      continue;
    }

    cumulativeMin += dtMin;

    const risingSlope = (prev: number | null | undefined, curr: number | null | undefined) => {
      if (prev == null || curr == null) return 0;
      return Math.max(0, (curr - prev) / dtMin);
    };

    const sT01 = risingSlope(prev.t01, curr.t01);
    const sT02 = risingSlope(prev.t02, curr.t02);
    const sT03 = risingSlope(prev.t03, curr.t03);
    const maxSlope = Math.max(sT01, sT02, sT03);

    points.push({
      fakeTime: Math.floor(cumulativeMin * 60) as UTCTimestamp,
      cumulativeMin,
      maxSlope,
      slopeT01: sT01,
      slopeT02: sT02,
      slopeT03: sT03,
    });
  }

  return points;
}

/** Bin slope points, keeping the max slope within each bin. */
function binSlopePoints(points: SlopePoint[], bins = 300): SlopePoint[] {
  if (points.length <= bins) return points;
  const step = Math.max(1, Math.floor(points.length / bins));
  const out: SlopePoint[] = [];
  for (let i = 0; i < points.length; i += step) {
    const slice = points.slice(i, Math.min(i + step, points.length));
    const worst = slice.reduce(
      (best, p) => (p.maxSlope > best.maxSlope ? p : best),
      slice[0],
    );
    out.push(worst);
  }
  return out;
}

/**
 * Seal temperature slope histogram.
 *
 * X-axis  — Cumulative P01 active runtime (minutes). Only time when P01 is in
 *            the active band advances the counter; machine-off gaps are skipped.
 * Y-axis  — Max rising dT/dt across T01/T02/T03 (°C/min).
 * Colours — Green < warn threshold · Amber ≥ warn < crit · Red ≥ crit
 *           Thresholds are tunable via config/logic-params.json → temp_slope.
 */
export function TemperatureChart({ series }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const hasTempData = useMemo(
    () => series.some((s) => s.t01 != null || s.t02 != null || s.t03 != null),
    [series],
  );

  const slopePoints = useMemo(() => {
    if (!hasTempData) return [];
    return binSlopePoints(computeSlopePoints(series));
  }, [series, hasTempData]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || slopePoints.length === 0) return;

    const WARN = LOGIC.TEMP_SLOPE_WARN_CPM;
    const CRIT = LOGIC.TEMP_SLOPE_CRIT_CPM;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 200,
      layout: {
        background: { color: "#1c1814" },
        textColor: "#8a7a60",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#2e2820" },
        horzLines: { color: "#2e2820" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#4a3c28", width: 1, style: 1, labelBackgroundColor: "#2e2820" },
        horzLine: { color: "#4a3c28", width: 1, style: 1, labelBackgroundColor: "#2e2820" },
      },
      rightPriceScale: {
        borderColor: "#2e2820",
        scaleMargins: { top: 0.08, bottom: 0.04 },
      },
      timeScale: {
        borderColor: "#2e2820",
        timeVisible: false,
        tickMarkFormatter: (t: UTCTimestamp) => `${Math.round((t as number) / 60)} min`,
      },
    });
    chartRef.current = chart;

    const histSeries = chart.addSeries(HistogramSeries, {
      base: 0,
      title: "dT/dt max",
      priceScaleId: "right",
      lastValueVisible: true,
      priceLineVisible: false,
    });

    // Reference lines for warn / crit thresholds
    histSeries.createPriceLine({
      price: WARN,
      color: "rgba(200,90,16,0.6)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `warn ${WARN} °C/min`,
    });
    histSeries.createPriceLine({
      price: CRIT,
      color: "rgba(204,51,17,0.6)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `crit ${CRIT} °C/min`,
    });

    histSeries.setData(
      slopePoints.map((p) => ({
        time: p.fakeTime,
        value: p.maxSlope,
        color:
          p.maxSlope >= CRIT
            ? "#cc3311"
            : p.maxSlope >= WARN
            ? "#c85a10"
            : "#6ab04c",
      })),
    );

    chart.timeScale().fitContent();

    // ── Crosshair tooltip ────────────────────────────────────────────────────

    const tooltip = tooltipRef.current;
    const byTime = new Map<number, SlopePoint>(
      slopePoints.map((p) => [p.fakeTime as number, p]),
    );

    function nearest(ts: UTCTimestamp): SlopePoint | null {
      const exact = byTime.get(ts as number);
      if (exact) return exact;
      let best: SlopePoint | null = null;
      let bestDist = Infinity;
      for (const [k, v] of byTime) {
        const d = Math.abs(k - (ts as number));
        if (d < bestDist) { bestDist = d; best = v; }
      }
      return best;
    }

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      if (!tooltip) return;
      if (!param.time || !param.point ||
          (param.point.x as number) < 0 || (param.point.y as number) < 0) {
        tooltip.style.display = "none";
        return;
      }

      const pt = nearest(param.time as UTCTimestamp);
      if (!pt) { tooltip.style.display = "none"; return; }

      const sensorLine = (label: string, val: number, isWorst: boolean) => {
        const color = isWorst ? "#e8a020" : "#5a4a38";
        return `<div style="display:flex;align-items:center;gap:6px">
          <span style="color:${color};font-family:monospace">${label}</span>
          <span style="color:#f0dfc0;font-family:monospace">${val.toFixed(3)} °C/min</span>
        </div>`;
      };

      const worstVal = pt.maxSlope;
      tooltip.innerHTML = `
        <div style="color:#5a4a38;font-size:10px;margin-bottom:3px;font-family:monospace;letter-spacing:0.1em">
          RUNTIME: ${pt.cumulativeMin.toFixed(1)} min
        </div>
        ${sensorLine("T01", pt.slopeT01, pt.slopeT01 === worstVal && worstVal > 0)}
        ${sensorLine("T02", pt.slopeT02, pt.slopeT02 === worstVal && worstVal > 0)}
        ${sensorLine("T03", pt.slopeT03, pt.slopeT03 === worstVal && worstVal > 0)}
        <div style="display:flex;align-items:center;gap:6px;border-top:1px solid #2e2820;margin-top:4px;padding-top:4px">
          <span style="color:#c85a10;font-family:monospace">MAX</span>
          <span style="color:#f0dfc0;font-family:monospace">${worstVal.toFixed(3)} °C/min</span>
        </div>
      `;

      tooltip.style.display = "block";
      const px = param.point.x as number;
      const py = param.point.y as number;
      const w = el.clientWidth;
      const ttW = 210;
      const ttH = 120;
      const left = px + 14 + ttW > w ? px - 14 - ttW : px + 14;
      const top = py + 14 + ttH > el.clientHeight ? py - 14 - ttH : py + 14;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.borderColor = "#e8a020";
    });

    // ── Resize observer ──────────────────────────────────────────────────────

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) chart.applyOptions({ width: w });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [slopePoints]);

  if (!hasTempData) {
    return (
      <div className="flex h-40 items-center justify-center border-2 border-[#2e2820] bg-[#1c1814] font-mono text-sm text-[#5a4a38]">
        NO SEAL-TEMP DATA — RUN <code className="mx-1 text-[#8a7a60]">python data_pipeline.py</code> TO POPULATE T01–T03
      </div>
    );
  }

  if (slopePoints.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center border-2 border-[#2e2820] bg-[#1c1814] font-mono text-sm text-[#5a4a38]">
        NO ACTIVE-RUN TEMPERATURE SAMPLES AVAILABLE
      </div>
    );
  }

  return (
    <div className="border-2 border-[#2e2820] bg-[#1c1814] p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div className="font-orbitron uppercase tracking-[0.18em] text-[#c85a10]">
            Seal Temperature Slope · dT/dt
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#5a4a38]">
            Active runs only · x-axis = cumulative P01 runtime (min) · worst-case rise rate across T01–T03
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-[#8a7a60]">
          <LegendSwatch color="#6ab04c" label={`< ${LOGIC.TEMP_SLOPE_WARN_CPM} °C/min`} />
          <LegendSwatch color="#c85a10" label={`≥ ${LOGIC.TEMP_SLOPE_WARN_CPM} °C/min`} />
          <LegendSwatch color="#cc3311" label={`≥ ${LOGIC.TEMP_SLOPE_CRIT_CPM} °C/min`} />
        </div>
      </div>

      {/* Chart */}
      <div className="relative overflow-hidden">
        <div ref={containerRef} />
        <div
          ref={tooltipRef}
          style={{
            position: "absolute",
            display: "none",
            minWidth: 200,
            zIndex: 10,
            pointerEvents: "none",
            background: "#0e0c0a",
            border: "1px solid #e8a020",
            borderRadius: 0,
            padding: "8px 10px",
            lineHeight: "1.55",
            fontSize: 11,
            fontFamily: "monospace",
            boxShadow: "0 4px 16px rgba(0,0,0,0.7)",
          }}
        />
      </div>

      <div className="mt-1.5 font-mono text-[9px] text-[#4a3c28]">
        ↑ dT/dt (°C/min) · right axis · hover for per-sensor breakdown
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-2 w-3" style={{ background: color }} />
      {label}
    </span>
  );
}
