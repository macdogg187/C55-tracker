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
import {
  LOGIC,
  type FatigueSample,
  type RunRecord,
} from "@/lib/analytics";

// ---------------------------------------------------------------------------
// Client-side pass detection (mirrors pass-detect.ts but works on the
// downsampled FatigueSample[] that the browser already has).
// ---------------------------------------------------------------------------

type PassStatus = "valid" | "short" | "long";

type Pass = {
  pass_index: number;
  started_at_ms: number;
  ended_at_ms: number;
  duration_min: number;
  avg_p01_kpsi: number;
  status: PassStatus;
};

type StoppageDetectionConfig = {
  min_dip_duration_min: number;
  dip_ratio_floor: number;
};

type PassDetectionConfig = {
  active_band_low_kpsi: number;
  active_band_high_kpsi: number;
  min_duration_min: number;
  max_duration_min: number;
  intra_pass_gap_min: number;
  stoppage_detection: StoppageDetectionConfig;
};

const PASS_CFG: PassDetectionConfig = {
  active_band_low_kpsi: LOGIC.ACTIVE_BAND_LOW_KPSI,
  active_band_high_kpsi: LOGIC.ACTIVE_BAND_HIGH_KPSI,
  min_duration_min: 34,
  max_duration_min: 40,
  intra_pass_gap_min: 2,
  stoppage_detection: {
    min_dip_duration_min: 3,
    dip_ratio_floor: 0.6,
  },
};

function detectPasses(series: FatigueSample[], cfg: PassDetectionConfig = PASS_CFG): Pass[] {
  const times: number[] = [];
  const p01: number[] = [];
  for (const s of series) {
    const t = new Date(s.ts).getTime();
    if (Number.isFinite(t) && Number.isFinite(s.p01)) {
      times.push(t);
      p01.push(s.p01);
    }
  }

  const passes: Pass[] = [];
  const n = times.length;
  if (n === 0) return passes;

  const gapMs = cfg.intra_pass_gap_min * 60_000;
  let i = 0;
  let passIdx = 0;

  while (i < n) {
    if (p01[i] < cfg.active_band_low_kpsi || p01[i] > cfg.active_band_high_kpsi) { i++; continue; }
    const startIdx = i;
    let endIdx = i;
    let sum = 0;
    let count = 0;

    while (endIdx < n) {
      const v = p01[endIdx];
      if (v < cfg.active_band_low_kpsi || v > cfg.active_band_high_kpsi) break;
      if (endIdx > startIdx && times[endIdx] - times[endIdx - 1] > gapMs) break;
      sum += v;
      count++;
      endIdx++;
    }

    const lastIdx = endIdx - 1;
    const durMin = (times[lastIdx] - times[startIdx]) / 60_000;
    const status: PassStatus =
      durMin < cfg.min_duration_min
        ? "short"
        : durMin > cfg.max_duration_min
          ? "long"
          : "valid";

    passIdx++;
    passes.push({
      pass_index: passIdx,
      started_at_ms: times[startIdx],
      ended_at_ms: times[lastIdx],
      duration_min: Math.round(durMin * 100) / 100,
      avg_p01_kpsi: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
      status,
    });
    i = endIdx;
  }

  return subdivideLongPasses(passes, times, p01, cfg);
}

function subdivideLongPasses(
  passes: Pass[],
  times: number[],
  p01: number[],
  cfg: PassDetectionConfig,
): Pass[] {
  if (!passes.some((p) => p.status === "long")) return passes;

  const sd = cfg.stoppage_detection;
  const minDipMs = sd.min_dip_duration_min * 60_000;
  const result: Pass[] = [];

  for (const pass of passes) {
    if (pass.status !== "long") { result.push(pass); continue; }

    const dipFloor = pass.avg_p01_kpsi * sd.dip_ratio_floor;
    const startMs = pass.started_at_ms;
    const endMs = pass.ended_at_ms;

    let lo = 0;
    while (lo < times.length && times[lo] < startMs) lo++;
    let hi = times.length - 1;
    while (hi > lo && times[hi] > endMs) hi--;

    const splitPoints: number[] = [];
    let j = lo;
    while (j <= hi) {
      if (p01[j] < dipFloor) {
        const dipStart = j;
        let dipEnd = j;
        while (dipEnd <= hi && p01[dipEnd] < dipFloor) dipEnd++;
        dipEnd--;
        if (times[dipEnd] - times[dipStart] >= minDipMs) splitPoints.push(dipStart);
        j = dipEnd + 1;
      } else {
        j++;
      }
    }

    if (splitPoints.length === 0) { result.push(pass); continue; }

    const boundaries = [lo, ...splitPoints, hi + 1];
    for (let b = 0; b < boundaries.length - 1; b++) {
      let segLo = boundaries[b];
      const segHi = boundaries[b + 1];
      while (segLo < segHi && p01[segLo] < cfg.active_band_low_kpsi) segLo++;
      let segEnd = segHi - 1;
      while (segEnd > segLo && p01[segEnd] < cfg.active_band_low_kpsi) segEnd--;
      if (segLo > segEnd) continue;

      let sum = 0; let count = 0;
      let firstInBand = -1; let lastInBand = -1;
      for (let k = segLo; k <= segEnd; k++) {
        const v = p01[k];
        if (v >= cfg.active_band_low_kpsi && v <= cfg.active_band_high_kpsi) {
          if (firstInBand === -1) firstInBand = k;
          lastInBand = k;
          sum += v; count++;
        }
      }
      if (count === 0 || firstInBand === -1) continue;

      const durMin = (times[lastInBand] - times[firstInBand]) / 60_000;
      const status: PassStatus =
        durMin < cfg.min_duration_min ? "short" : durMin > cfg.max_duration_min ? "long" : "valid";

      result.push({
        pass_index: 0,
        started_at_ms: times[firstInBand],
        ended_at_ms: times[lastInBand],
        duration_min: Math.round(durMin * 100) / 100,
        avg_p01_kpsi: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
        status,
      });
    }
  }

  result.sort((a, b) => a.started_at_ms - b.started_at_ms);
  for (let k = 0; k < result.length; k++) result[k].pass_index = k + 1;
  return result;
}

// ---------------------------------------------------------------------------
// Histogram component
// ---------------------------------------------------------------------------

type HistogramBin = {
  time: UTCTimestamp;
  value: number;
  color: string;
  label: string;
  duration_min: number;
  deficit_min: number;
};

type Props = {
  series: FatigueSample[];
  runs?: RunRecord[];
};

const MIN_DUR = PASS_CFG.min_duration_min;

export function PrematureStoppageHistogram({ series }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const passes = useMemo(() => detectPasses(series), [series]);

  const { bins, shortPasses, validPasses } = useMemo(() => {
    const short = passes.filter((p) => p.status === "short");
    const valid = passes.filter((p) => p.status === "valid");

    // Build histogram bins: one bar per short pass, x = pass start time,
    // height = deficit below min_duration (how many minutes short).
    const bins: HistogramBin[] = short.map((p) => {
      const deficit = MIN_DUR - p.duration_min;
      const time = Math.floor(p.started_at_ms / 1000) as UTCTimestamp;
      let color: string;
      let label: string;
      if (p.duration_min < 10) {
        color = "#A82020";
        label = "severe";
      } else if (p.duration_min < 20) {
        color = "#C04810";
        label = "moderate";
      } else {
        color = "#B8860B";
        label = "marginal";
      }
      return { time, value: Math.round(deficit * 100) / 100, color, label, duration_min: p.duration_min, deficit_min: deficit };
    });

    return { bins, shortPasses: short, validPasses: valid };
  }, [passes]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || bins.length === 0) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 180,
      layout: {
        background: { color: "#F0EFE8" },
        textColor: "#4A4A42",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#D5D3C8" },
        horzLines: { color: "#D5D3C8" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#7A7768", width: 1, style: 1, labelBackgroundColor: "#E5E3DA" },
        horzLine: { color: "#7A7768", width: 1, style: 1, labelBackgroundColor: "#E5E3DA" },
      },
      rightPriceScale: {
        borderColor: "#B0AD9E",
        scaleMargins: { top: 0.08, bottom: 0.04 },
      },
      timeScale: {
        borderColor: "#B0AD9E",
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
    });
    chartRef.current = chart;

    const histSeries = chart.addSeries(HistogramSeries, {
      base: 0,
      title: "Deficit (min)",
      priceScaleId: "right",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // Reference line at the full-deficit level (34 min deficit = 0-min pass)
    histSeries.createPriceLine({
      price: MIN_DUR,
      color: "rgba(168,32,32,0.4)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `${MIN_DUR} min (full deficit)`,
    });

    histSeries.setData(bins);
    chart.timeScale().fitContent();

    // ── Crosshair tooltip ────────────────────────────────────────────────────

    const tooltip = tooltipRef.current;
    const byTime = new Map<number, HistogramBin>(
      bins.map((b) => [b.time as number, b]),
    );

    function nearest(ts: UTCTimestamp): HistogramBin | null {
      const exact = byTime.get(ts as number);
      if (exact) return exact;
      let best: HistogramBin | null = null;
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

      const bin = nearest(param.time as UTCTimestamp);
      if (!bin) { tooltip.style.display = "none"; return; }

      const d = new Date((param.time as number) * 1000);
      const timeLabel =
        d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      const severityColor =
        bin.label === "severe" ? "#A82020" :
        bin.label === "moderate" ? "#C04810" : "#B8860B";

      tooltip.innerHTML = `
        <div style="color:#787870;font-size:10px;margin-bottom:3px;letter-spacing:0.1em">${timeLabel}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:${severityColor};font-weight:600;text-transform:uppercase;font-size:9px">${bin.label}</span>
          <span style="color:#1A1A16">${bin.duration_min.toFixed(1)} min pass</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
          <span style="color:#C04810">Deficit</span>
          <span style="color:#1A1A16">${bin.deficit_min.toFixed(1)} min below ${MIN_DUR} min floor</span>
        </div>
      `;
      tooltip.style.display = "block";

      const px = param.point.x as number;
      const py = param.point.y as number;
      const w = el.clientWidth;
      const ttW = 240;
      const ttH = 80;
      const left = px + 14 + ttW > w ? px - 14 - ttW : px + 14;
      const top = py + 14 + ttH > el.clientHeight ? py - 14 - ttH : py + 14;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
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
  }, [bins]);

  if (passes.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center border border-[#B0AD9E] bg-[#E5E3DA] text-sm text-[#787870] rounded-sm">
        NO PASS DATA — UPLOAD VANTAGEPOINT CSV WITH P01 DATA
      </div>
    );
  }

  if (shortPasses.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center border border-[#B0AD9E] bg-[#E5E3DA] text-sm text-[#2B7A3E] rounded-sm">
        ALL PASSES WITHIN RANGE ({validPasses.length} valid, 0 premature stoppages)
      </div>
    );
  }

  const totalDeficit = shortPasses.reduce((s, p) => s + (MIN_DUR - p.duration_min), 0);
  const severeCount = shortPasses.filter((p) => p.duration_min < 10).length;
  const moderateCount = shortPasses.filter((p) => p.duration_min >= 10 && p.duration_min < 20).length;
  const marginalCount = shortPasses.filter((p) => p.duration_min >= 20).length;

  return (
    <div className="border border-[#B0AD9E] bg-[#E5E3DA] p-3 rounded-sm">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div className="font-barlow uppercase tracking-[0.18em] text-[#A82020]">
            Premature Pass Stoppages · Deficit Below {MIN_DUR} min
          </div>
          <div className="mt-0.5 text-[10px] text-[#787870]">
            {shortPasses.length} premature stoppage{shortPasses.length > 1 ? "s" : ""} out of {passes.length} passes · {totalDeficit.toFixed(0)} min total deficit · avg deficit {(totalDeficit / shortPasses.length).toFixed(1)} min
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-[#4A4A42]">
          <LegendSwatch color="#A82020" label={`Severe (< 10 min): ${severeCount}`} />
          <LegendSwatch color="#C04810" label={`Moderate (10–20 min): ${moderateCount}`} />
          <LegendSwatch color="#B8860B" label={`Marginal (20–${MIN_DUR} min): ${marginalCount}`} />
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
            minWidth: 220,
            zIndex: 10,
            pointerEvents: "none",
            background: "#FAFAF5",
            border: "1px solid #A82020",
            borderRadius: "4px",
            padding: "8px 10px",
            lineHeight: "1.55",
            fontSize: 11,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
          }}
        />
      </div>

      <div className="mt-1.5 text-[9px] text-[#7A7768]">
        ↑ Deficit (min below {MIN_DUR}-min floor) · right axis · hover for details
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-3 rounded-sm"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
