"use client";

import { useEffect, useRef, useMemo, useCallback } from "react";
import {
  createChart,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  CrosshairMode,
  type UTCTimestamp,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import {
  binFatigueSeries,
  LOGIC,
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
 * Single-pane fatigue chart: P01 pressure line + σ pulsation histogram.
 *
 * Zoom/pan state is preserved across data refreshes — the chart is created
 * once and updated in-place via setData() rather than being torn down.
 */
export function FatigueChart({ series, runs, parts }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const p01SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const sigmaSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

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

  // Build marker data from runs, status, and parts
  const markers = useMemo(() => {
    const m: SeriesMarker<UTCTimestamp>[] = [];

    if (runs && runs.length > 0) {
      for (const run of runs) {
        m.push({
          time: toUTC(run.started_at),
          position: "belowBar",
          color: "#C04810",
          shape: "arrowUp",
          text: `Run ${run.run_index + 1}`,
          size: 0.7,
        });
      }
    }

    for (const s of binned) {
      if (s.status === "out_of_band") {
        m.push({
          time: toUTC(s.ts),
          position: "aboveBar",
          color: "#A82020",
          shape: "circle",
          size: 0.5,
        });
      } else if (s.status === "high_stress") {
        m.push({
          time: toUTC(s.ts),
          position: "aboveBar",
          color: "#B8860B",
          shape: "circle",
          size: 0.4,
        });
      }
    }

    if (parts && parts.length > 0) {
      for (const part of parts) {
        const installDate = part.effective_installation_date ?? part.installation_date;
        const removalDate = part.effective_removal_date ?? part.removal_date;
        const isFallbackInstall = part.boundary_source?.install === "tracker_fallback";

        m.push({
          time: toUTC(installDate),
          position: "belowBar",
          color: isFallbackInstall ? "#9A3A0E" : "#C04810",
          shape: "arrowUp",
          text: `${part.part_name} in`,
          size: 0.6,
        });

        if (removalDate) {
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
          m.push({
            time: toUTC(removalDate),
            position: "aboveBar",
            color: "#B8860B",
            shape: "arrowDown",
            text: `${part.part_name} out${duringRunText}`,
            size: 0.6,
          });
        }
      }
    }

    m.sort((a, b) => (a.time as number) - (b.time as number));
    return m;
  }, [binned, runs, parts]);

  // ── Initialize chart once ────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 340,
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
        scaleMargins: { top: 0.06, bottom: 0.06 },
      },
      leftPriceScale: {
        visible: true,
        borderColor: "#B0AD9E",
        scaleMargins: { top: 0.65, bottom: 0.0 },
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

    const p01S = chart.addSeries(LineSeries, {
      color: "#C04810",
      lineWidth: 2,
      title: "P01 (kpsi)",
      priceScaleId: "right",
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: "#9A3A0E",
      crosshairMarkerBackgroundColor: "#C04810",
    });
    p01SeriesRef.current = p01S;

    const sigmaS = chart.addSeries(HistogramSeries, {
      color: "rgba(218,165,32,0.75)",
      base: 0,
      title: "σ (kpsi)",
      priceScaleId: "left",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    sigmaSeriesRef.current = sigmaS;

    // Reference lines
    p01S.createPriceLine({
      price: LOGIC.ACTIVE_BAND_HIGH_KPSI,
      color: "#7A7768",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `${LOGIC.ACTIVE_BAND_HIGH_KPSI} kpsi`,
    });
    p01S.createPriceLine({
      price: LOGIC.ACTIVE_BAND_LOW_KPSI,
      color: "#7A7768",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `${LOGIC.ACTIVE_BAND_LOW_KPSI} kpsi`,
    });
    sigmaS.createPriceLine({
      price: LOGIC.PULSATION_STDEV_KPSI,
      color: "rgba(218,165,32,0.6)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "σ limit",
    });

    // ── Crosshair tooltip ──────────────────────────────────────────────────

    const tooltip = tooltipRef.current;
    const p01ByTimeRef = new Map<number, FatigueSample>();

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
      const exact = p01ByTimeRef.get(utcTime as number);
      let best: FatigueSample | null = exact ?? null;
      if (!best) {
        let bestDist = Infinity;
        for (const [k, v] of p01ByTimeRef) {
          const d = Math.abs(k - (utcTime as number));
          if (d < bestDist) { bestDist = d; best = v; }
        }
      }
      if (!best) { tooltip.style.display = "none"; return; }

      const sample = best;
      const d = new Date((utcTime as number) * 1000);
      const timeLabel =
        d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      const statusBadge =
        sample.status === "high_stress"
          ? `<span style="color:#B8860B;font-size:9px;margin-left:4px">⚠ HIGH-STRESS</span>`
          : sample.status === "out_of_band"
            ? `<span style="color:#A82020;font-size:9px;margin-left:4px">✕ OUT-OF-BAND</span>`
            : "";

      const sigmaFlag =
        sample.stdev > LOGIC.PULSATION_STDEV_KPSI
          ? `<span style="color:#B8860B;font-size:9px;margin-left:4px">ABOVE LIMIT</span>`
          : "";

      tooltip.innerHTML = `
        <div style="color:#787870;font-size:10px;margin-bottom:3px;letter-spacing:0.1em">${timeLabel}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:#C04810">P01</span>
          <span style="color:#1A1A16">${sample.p01.toFixed(2)} kpsi</span>
          ${statusBadge}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="color:#B8860B">&nbsp;σ&nbsp;</span>
          <span style="color:#1A1A16">${sample.stdev.toFixed(3)} kpsi</span>
          ${sigmaFlag}
        </div>
      `;

      tooltip.style.display = "block";

      const px = param.point.x as number;
      const py = param.point.y as number;
      const w = el.clientWidth;
      const ttW = 210;
      const ttH = 80;
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

    // Store the lookup-map setter so the data-update effect can populate it
    (el as HTMLDivElement & { __setP01Map: (m: Map<number, FatigueSample>) => void }).__setP01Map = (m) => {
      p01ByTimeRef.clear();
      for (const [k, v] of m) p01ByTimeRef.set(k, v);
    };

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      p01SeriesRef.current = null;
      sigmaSeriesRef.current = null;
      initializedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — chart created once

  // ── Update data without destroying the chart ──────────────────────────────
  useEffect(() => {
    const p01S = p01SeriesRef.current;
    const sigmaS = sigmaSeriesRef.current;
    const chart = chartRef.current;
    const el = containerRef.current;
    if (!p01S || !sigmaS || !chart || !el || binned.length === 0) return;

    const p01Data = binned.map((s) => ({ time: toUTC(s.ts), value: s.p01 }));
    const sigmaData = binned.map((s) => ({ time: toUTC(s.ts), value: s.stdev }));

    p01S.setData(p01Data);
    sigmaS.setData(sigmaData);

    // Update the tooltip lookup map
    const mapSetter = (el as HTMLDivElement & { __setP01Map?: (m: Map<number, FatigueSample>) => void }).__setP01Map;
    if (mapSetter) {
      mapSetter(new Map<number, FatigueSample>(
        binned.map((s) => [toUTC(s.ts) as number, s]),
      ));
    }

    // Update markers
    createSeriesMarkers(p01S, markers);

    // Only fit content on first render, not on subsequent data updates
    if (!initializedRef.current) {
      chart.timeScale().fitContent();
      initializedRef.current = true;
    }
  }, [binned, markers]);

  if (active.length === 0 && series.length > 0) {
    return (
      <div className="flex h-64 items-center justify-center border border-[#B0AD9E] bg-[#E5E3DA] text-sm text-[#787870] rounded-sm">
        NO ACTIVE-RUN SAMPLES — UPLOAD VANTAGEPOINT CSV WITH P01 DATA
      </div>
    );
  }

  return (
    <div className="border border-[#B0AD9E] bg-[#E5E3DA] p-3 rounded-sm">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <div className="font-barlow uppercase tracking-[0.18em] text-[#C04810]">
            Fatigue · P01 Pressure + σ Pulsation
          </div>
          <div className="mt-0.5 text-[10px] text-[#787870]">
            Active runs only · scroll to zoom · drag to pan · hover for crosshair
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-[#4A4A42]">
          <LegendSwatch color="#C04810" label={`P01 (right, kpsi)`} />
          <LegendSwatch color="rgba(218,165,32,0.75)" label={`σ ${LOGIC.ROLLING_WINDOW_MIN}-min (left, kpsi)`} />
          <LegendSwatch color="#B8860B" label="High-stress" />
          <LegendSwatch color="#A82020" label="Out-of-band" />
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
            background: "#FAFAF5",
            border: "1px solid #C04810",
            borderRadius: "4px",
            padding: "8px 10px",
            lineHeight: "1.55",
            fontSize: 11,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
          }}
        />
      </div>

      {/* Axis labels */}
      <div className="mt-1.5 text-[9px] text-[#7A7768]">
        P01 (right axis) · σ pulsation (left axis)
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
