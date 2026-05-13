"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FailurePredictionPanel } from "../components/FailurePredictionPanel";
import { FatigueChart } from "../components/FatigueChart";
import type { FatigueSample, PipelinePayload, WindowSpan } from "@/lib/analytics";

export default function PredictPage() {
  const searchParams = useSearchParams();
  const equipmentId = searchParams.get("eq") ?? "0091";

  const [pipelinePayload, setPipelinePayload] = useState<PipelinePayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/pipeline.json", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as PipelinePayload;
        if (!cancelled) setPipelinePayload(json);
      } catch {
        // No pipeline yet — predictions still work from lifecycle data.
      }
    }
    void load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const fatigue: FatigueSample[] = useMemo(
    () => pipelinePayload?.fatigue_series ?? [],
    [pipelinePayload],
  );
  const offWindows: WindowSpan[] = useMemo(
    () => pipelinePayload?.off_windows ?? [],
    [pipelinePayload],
  );
  const highStress: WindowSpan[] = useMemo(
    () => pipelinePayload?.high_stress_windows ?? [],
    [pipelinePayload],
  );
  return (
    <main className="min-h-screen bg-[#12100e] text-[#f0dfc0]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">

        <div>
          <p className="font-orbitron text-xs uppercase tracking-widest text-[#e8a020]">Analysis</p>
          <h1 className="mt-1 font-orbitron text-2xl font-semibold text-[#f0dfc0]">Failure Prediction</h1>
          <p className="mt-1 font-mono text-sm text-[#5a4a38]">
            Equipment{" "}
            <span className="text-[#e8a020]">{equipmentId}</span>
            {" · "}Risk scores combine runtime ratio, high-stress exposure, cumulative pressure stress,
            and inferred failure windows.
          </p>
        </div>

        <FailurePredictionPanel
          equipmentId={equipmentId}
          refreshKey={refreshKey}
          onSelect={(id) => setSelectedId(id)}
          selectedId={selectedId}
          replaceHref={(installationId) =>
            `/replace?eq=${equipmentId}&part=${installationId}`
          }
        />

        {fatigue.length > 0 && (
          <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-orbitron text-sm font-semibold uppercase tracking-widest text-[#e8a020]">
                Sensor Fatigue Chart
              </h2>
              <p className="font-mono text-xs text-[#5a4a38]">
                P01 pressure + rolling 10-min σ — correlation between high pulsation and HP-thread risk.
              </p>
            </div>
            <FatigueChart
              series={fatigue}
              highStress={highStress}
              offWindows={offWindows}
            />
          </section>
        )}

        {fatigue.length === 0 && (
          <p className="border-2 border-[#2e2820] bg-[#1c1814] px-5 py-6 font-mono text-sm text-[#5a4a38]">
            Upload a VantagePoint CSV on the{" "}
            <a href={`/?eq=${equipmentId}`} className="text-[#e8a020] hover:underline">
              Dashboard
            </a>{" "}
            to enable the fatigue chart.
          </p>
        )}

      </div>
    </main>
  );
}
