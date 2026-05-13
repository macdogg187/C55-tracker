"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  CrosshairMode,
  type UTCTimestamp,
  type IChartApi,
  type SeriesMarker,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  binFatigueSeries,
  computeCumulativeStress,
  LOGIC,
  type CumulativeStressPoint,
  type FatigueSample,
  type PartRecord,
  type RunRecord,
  type WindowSpan,
} from "@/lib/analytics";

type Props = {
  series: FatigueSample[];
  highStress: WindowSpan[];
  offWindows: WindowSpan[];
  runs?: RunRecord[];
  parts?: PartRecord[];
};

function toUTC(ts: string): UTCTimestamp {
  return Math.floor(new Date(ts).getTime() / 1000) as UTCTimestamp;
}

/**
 * Interactive two-pane fatigue chart powered by lightweight-charts (TradingView).
 *
 * Pane 0 — Pressure + pulsation:
 *   • Cyan line  = P01 homogenizing pressure (right scale, kpsi)
 *   • Rose line  = 10-min rolling σ (left scale, kpsi)
 *   • Amber ◯   = high-stress samples (σ > 2 kpsi)
 *   • Red ◯     = out-of-band samples (P01 > 30 kpsi)
 *   • ↑ markers  = production run start boundaries
 *   • Dashed ref lines at 15 / 30 kpsi and σ = 2 kpsi
 *
 * Pane 1 — Cumulative stress:
 *   • Histogram = running Σ (p01 − 19 kpsi) × Δt in kpsi-min
 *   • Green → amber → red as accumulated fatigue climbs
 *
 * Supports zoom / pan (scroll wheel + drag) and a hover crosshair
 * tooltip showing exact P01, σ, and cumulative stress at any point.
 */
export function FatigueChart({ series, runs, parts }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

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

  const binned = useMemo(() => binFatigueSeries(active, 600), [active]);
  const cumStress = useMemo(
    () => computeCumulativeStress(binned, LOGIC.ACTIVE_BAND_LOW_KPSI, parts),
    [binned, parts],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || binned.length === 0) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 420,
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
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      leftPriceScale: {
        visible: true,
        borderColor: "#2e2820",
        // Compress sigma to the lower third of pane 0 so it doesn't crowd P01
        scaleMargins: { top: 0.65, bottom: 0.0 },
      },
      timeScale: {
        borderColor: "#2e2820",
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
    });
    chartRef.current = chart;

    // ── Pane 0: P01 + sigma ────────────────────────────────────────────────

    chart.panes()[0].setHeight(270);

    const p01S = chart.addSeries(LineSeries, {
      color: "#e8a020",
      lineWidth: 2,
      title: "P01",
      priceScaleId: "right",
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: "#a06e10",
      crosshairMarkerBackgroundColor: "#e8a020",
    });

    const sigmaS = chart.addSeries(HistogramSeries, {
      color: "rgba(200,90,16,0.75)",
      base: 0,
      title: "σ",
      priceScaleId: "left",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    // Reference lines
    p01S.createPriceLine({
      price: LOGIC.ACTIVE_BAND_HIGH_KPSI,
      color: "#4a3c28",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `${LOGIC.ACTIVE_BAND_HIGH_KPSI} kpsi`,
    });
    p01S.createPriceLine({
      price: LOGIC.ACTIVE_BAND_LOW_KPSI,
      color: "#4a3c28",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `${LOGIC.ACTIVE_BAND_LOW_KPSI} kpsi`,
    });
    sigmaS.createPriceLine({
      price: LOGIC.PULSATION_STDEV_KPSI,
      color: "rgba(200,90,16,0.6)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "σ limit",
    });

    // Data
    p01S.setData(binned.map((s) => ({ time: toUTC(s.ts), value: s.p01 })));
    sigmaS.setData(binned.map((s) => ({ time: toUTC(s.ts), value: s.stdev })));

    // ── Series markers: run starts + high-stress / out-of-band + part lifecycle ──

    const markers: SeriesMarker<UTCTimestamp>[] = [];

    if (runs && runs.length > 0) {
      for (const run of runs) {
        markers.push({
          time: toUTC(run.started_at),
          position: "belowBar",
          color: "#e8a020",
          shape: "arrowUp",
          text: `Run ${run.run_index + 1}`,
          size: 0.7,
        });
      }
    }

    for (const s of binned) {
      if (s.status === "out_of_band") {
        markers.push({
          time: toUTC(s.ts),
          position: "aboveBar",
          color: "#cc3311",
          shape: "circle",
          size: 0.5,
        });
      } else if (s.status === "high_stress") {
        markers.push({
          time: toUTC(s.ts),
          position: "aboveBar",
          color: "#c85a10",
          shape: "circle",
          size: 0.4,
        });
      }
    }

    if (parts && parts.length > 0) {
      for (const part of parts) {
        // Use gap-snapped effective dates if available, fall back to tracker dates.
        const installDate = part.effective_installation_date ?? part.installation_date;
        const removalDate = part.effective_removal_date ?? part.removal_date;
        const isFallbackInstall = part.boundary_source?.install === "tracker_fallback";

        // Installation marker — muted colour when boundary is a tracker fallback.
        markers.push({
          time: toUTC(installDate),
          position: "belowBar",
          color: isFallbackInstall ? "#a06e10" : "#e8a020",
          shape: "arrowUp",
          text: `${part.part_name} in`,
          size: 0.6,
        });

        if (removalDate) {
          // Check if the removal falls inside a production run.
          let duringRunText = "";
          if (runs && runs.length > 0) {
            const removalMs = new Date(removalDate).getTime();
            const match = runs.find(
              (r) =>
                removalMs >= new Date(r.started_at).getTime() &&
                removalMs <= new Date(r.ended_at).getTime(),
            );
            if (match) duringRunText = ` (during Run ${match.run_index + 1})`;
          }
          markers.push({
            time: toUTC(removalDate),
            position: "aboveBar",
            color: "#c85a10",
            shape: "arrowDown",
            text: `${part.part_name} out${duringRunText}`,
            size: 0.6,
          });
        }
      }
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(p01S, markers);

    // ── Pane 1: Cumulative stress histogram ────────────────────────────────

    const stressPane = chart.addPane();
    stressPane.setHeight(120);

    const stressSeries = stressPane.addSeries(HistogramSeries, {
      color: "#6ab04c",
      title: "Cumul. stress",
      priceScaleId: "right",
      lastValueVisible: true,
      priceLineVisible: false,
      base: 0,
    });

    // Build a per-lifecycle threshold lookup (in kpsi-min, same unit as cumStress).
    // Rate = part's observed kpsi-min per active-minute; thresholds are in minutes.
    type PartThresholds = { inspKpsiMin: number | null; failKpsiMin: number | null };
    const partThreshMap = new Map<string, PartThresholds>();
    if (parts && parts.length > 0) {
      for (const p of parts) {
        const rate =
          p.active_runtime_minutes > 0
            ? p.cumulative_pressure_stress / p.active_runtime_minutes
            : null;
        partThreshMap.set(p.installation_id, {
          inspKpsiMin: rate != null && p.inspection_threshold_min != null
            ? rate * p.inspection_threshold_min
            : null,
          failKpsiMin: rate != null && p.failure_threshold_min != null
            ? rate * p.failure_threshold_min
            : null,
        });
      }
    }

    // Fallback: colour relative to series max (used when no threshold data exists).
    const maxStress = Math.max(1, ...cumStress.map((p) => p.value));

    stressSeries.setData(
      cumStress.map((pt: CumulativeStressPoint) => {
        const thresh = pt.installation_id ? partThreshMap.get(pt.installation_id) : undefined;
        let color: string;
        if (thresh?.failKpsiMin != null && pt.value >= thresh.failKpsiMin) {
          color = "#cc3311";
        } else if (thresh?.inspKpsiMin != null && pt.value >= thresh.inspKpsiMin) {
          color = "#c85a10";
        } else if (thresh?.inspKpsiMin != null) {
          // Threshold data available and we're below inspection — olive.
          color = "#6ab04c";
        } else {
          // Fallback: relative-to-max colouring when no lifecycle thresholds available.
          const ratio = pt.value / maxStress;
          color = ratio > 0.75 ? "#cc3311" : ratio > 0.45 ? "#c85a10" : "#6ab04c";
        }
        return { time: toUTC(pt.ts), value: pt.value, color };
      }),
    );

    chart.timeScale().fitContent();

    // ── Crosshair tooltip ──────────────────────────────────────────────────

    const tooltip = tooltipRef.current;

    // Build lookup maps keyed by UTCTimestamp for O(1) hover lookups
    const p01ByTime = new Map<number, FatigueSample>(
      binned.map((s) => [toUTC(s.ts) as number, s]),
    );
    const stressByTime = new Map<number, number>(
      cumStress.map((p) => [toUTC(p.ts) as number, p.value]),
    );

    function nearestSample(ts: UTCTimestamp): FatigueSample | null {
      const exact = p01ByTime.get(ts as number);
      if (exact) return exact;
      let best: FatigueSample | null = null;
      let bestDist = Infinity;
      for (const [k, v] of p01ByTime) {
        const d = Math.abs(k - (ts as number));
        if (d < bestDist) { bestDist = d; best = v; }
      }
      return best;
    }

    function nearestStress(ts: UTCTimestamp): number {
      const exact = stressByTime.get(ts as number);
      if (exact !== undefined) return exact;
      let best = 0;
      let bestDist = Infinity;
      for (const [k, v] of stressByTime) {
        const d = Math.abs(k - (ts as number));
        if (d < bestDist) { bestDist = d; best = v; }
      }
      return best;
    }

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      if (!tooltip) return;
      if (
        !param.time ||
        !param.point ||
        (param.point.x as number) < 0 ||
        (param.point.y as number) < 0
      ) {
        tooltip.style.display = "none";
        return;
      }

      const utcTime = param.time as UTCTimestamp;
      const sample = nearestSample(utcTime);
      if (!sample) { tooltip.style.display = "none"; return; }

      const stress = nearestStress(utcTime);
      const d = new Date((utcTime as number) * 1000);
      const timeLabel =
        d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      const statusBadge =
        sample.status === "high_stress"
          ? `<span style="color:#c85a10;font-size:9px;margin-left:4px">⚠ HIGH-STRESS</span>`
          : sample.status === "out_of_band"
            ? `<span style="color:#cc3311;font-size:9px;margin-left:4px">✕ OUT-OF-BAND</span>`
            : "";

      const sigmaFlag =
        sample.stdev > LOGIC.PULSATION_STDEV_KPSI
          ? `<span style="color:#c85a10;font-size:9px;margin-left:4px">ABOVE LIMIT</span>`
          : "";

      tooltip.innerHTML = `
        <div style="color:#5a4a38;font-size:10px;margin-bottom:3px;font-family:monospace;letter-spacing:0.1em">${timeLabel}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:#e8a020;font-family:monospace">P01</span>
          <span style="color:#f0dfc0;font-family:monospace">${sample.p01.toFixed(2)} kpsi</span>
          ${statusBadge}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:#c85a10;font-family:monospace">&nbsp;σ&nbsp;</span>
          <span style="color:#f0dfc0;font-family:monospace">${sample.stdev.toFixed(3)} kpsi</span>
          ${sigmaFlag}
        </div>
        <div style="display:flex;align-items:center;gap:6px;border-top:1px solid #2e2820;margin-top:4px;padding-top:4px">
          <span style="color:#6ab04c;font-family:monospace">Σ</span>
          <span style="color:#f0dfc0;font-family:monospace">${stress.toFixed(0)} kpsi-min</span>
        </div>
      `;

      tooltip.style.display = "block";

      const px = param.point.x as number;
      const py = param.point.y as number;
      const w = el.clientWidth;
      const ttW = 210;
      const ttH = 100;
      const left = px + 14 + ttW > w ? px - 14 - ttW : px + 14;
      const top = py + 14 + ttH > el.clientHeight ? py - 14 - ttH : py + 14;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    });

    // ── Resize observer ────────────────────────────────────────────────────

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
  }, [binned, cumStress, runs, parts]);

  if (active.length === 0 && series.length > 0) {
    return (
      <div className="flex h-64 items-center justify-center border-2 border-[#2e2820] bg-[#1c1814] font-mono text-sm text-[#5a4a38]">
        NO ACTIVE-RUN SAMPLES — UPLOAD VANTAGEPOINT CSV WITH P01 DATA
      </div>
    );
  }

  return (
    <div className="border-2 border-[#2e2820] bg-[#1c1814] p-3">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div className="font-orbitron uppercase tracking-[0.18em] text-[#e8a020]">
            Fatigue · P01 Pressure + σ Pulsation
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[#5a4a38]">
            Active runs only · scroll to zoom · drag to pan · hover for crosshair
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-[#8a7a60]">
          <LegendSwatch color="#e8a020" label={`P01 (right, kpsi)`} />
          <LegendSwatch color="rgba(200,90,16,0.75)" label={`σ ${LOGIC.ROLLING_WINDOW_MIN}-min (left, kpsi)`} />
          <LegendSwatch color="#c85a10" label="High-stress" />
          <LegendSwatch color="#cc3311" label="Out-of-band" />
          <LegendGradient label="Cumul. stress (lower pane)" />
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

      {/* Pane labels */}
      <div className="mt-1.5 flex items-center justify-between font-mono text-[9px] text-[#4a3c28]">
        <span>↑ P01 (amber, right) · σ pulsation (orange, left)</span>
        <span>↓ Cumulative stress kpsi-min · olive → orange → red</span>
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-3"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function LegendGradient({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-6"
        style={{
          background: "linear-gradient(to right, #6ab04c, #c85a10, #cc3311)",
        }}
      />
      {label}
    </span>
  );
}
