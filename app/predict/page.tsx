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
    <main className="min-h-screen bg-[#030711] text-zinc-100">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">

        <div>
          <p className="text-xs uppercase tracking-widest text-cyan-400">Analysis</p>
          <h1 className="text-2xl font-semibold text-zinc-100">Failure Prediction</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Equipment{" "}
            <span className="font-mono text-zinc-300">{equipmentId}</span>
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
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-zinc-100">
                Sensor Fatigue Chart
              </h2>
              <p className="text-xs text-zinc-400">
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
          <p className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-5 py-6 text-sm text-zinc-500">
            Upload a VantagePoint CSV on the{" "}
            <a href={`/?eq=${equipmentId}`} className="text-cyan-400 hover:underline">
              Dashboard
            </a>{" "}
            to enable the fatigue chart.
          </p>
        )}

      </div>
    </main>
  );
}
