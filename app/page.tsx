"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  buildSeedPartStatuses,
  type PartStatus,
} from "@/lib/dashboard-data";
import { PART_CATALOG } from "@/lib/parts-catalog";
import type {
  FatigueSample,
  PartRecord,
  PipelinePayload,
  WindowSpan,
} from "@/lib/analytics";
import { useLiveLifecycles } from "@/lib/use-live-lifecycles";
import { SequentialFlowchart } from "./components/SequentialFlowchart";
import { FatigueChart } from "./components/FatigueChart";
import { TemperatureChart } from "./components/TemperatureChart";
import { MaintenanceLogPanel } from "./components/MaintenanceLogPanel";
import { DataIngestPanel } from "./components/DataIngestPanel";
import { SubassemblyGrid } from "./components/SubassemblyGrid";
import Link from "next/link";

type LifecycleSnapshot = {
  installation_id: string;
  serial_number: string;
  installation_date: string;
  removal_date: string | null;
  active_runtime_minutes: number;
  high_stress_minutes: number;
  cumulative_pressure_stress: number;
  inferred_failures: number;
  failure_mode: string | null;
  failure_notes: string | null;
  archived_at: string | null;
};

type SnapshotSlot = {
  installation_id: string;
  equipment_id: string;
  part_code: string;
  zone: PartStatus["zone"];
  orientation: PartStatus["orientation"];
  slot_index: number | null;
  sequence_order: number;
};

type SnapshotResponse = {
  backend: "supabase" | "local-json";
  generated_at: string;
  equipment: { equipment_id: string; display_name: string }[];
  slots: SnapshotSlot[];
  lifecycles: LifecycleSnapshot[];
  events: {
    id?: string;
    installation_id: string | null;
    event_type: string;
    failure_mode: string | null;
    detected_at: string;
    ended_at: string | null;
    duration_minutes: number | null;
    source: string | null;
    notes: string | null;
  }[];
};

function buildPartStatuses(
  equipmentId: string,
  snapshot: SnapshotResponse | null,
  pipelineParts: PartRecord[],
): PartStatus[] {
  const seedFromCatalog = buildSeedPartStatuses(equipmentId);
  const seedById = new Map(seedFromCatalog.map((p) => [p.installationId, p]));

  if (snapshot) {
    for (const slot of snapshot.slots) {
      if (slot.equipment_id !== equipmentId) continue;
      if (seedById.has(slot.installation_id)) continue;
      const catalog = PART_CATALOG[slot.part_code];
      if (!catalog) continue;
      seedById.set(slot.installation_id, {
        id: slot.installation_id,
        installationId: slot.installation_id,
        equipmentId: slot.equipment_id,
        partCode: slot.part_code,
        partName: catalog.displayName,
        category: catalog.category,
        isConsumable: catalog.isConsumable,
        isStructural: catalog.isStructural,
        isSerialized: catalog.isSerialized ?? false,
        zone: slot.zone,
        orientation: slot.orientation,
        sequenceOrder: slot.sequence_order,
        serialNumber: "",
        granularRuntimeMinutes: 0,
        highStressMinutes: 0,
        cumulativePressureStress: 0,
        expectedMtbfMinutes: catalog.expectedMtbfMinutes ?? null,
        inspectionThresholdMin: catalog.inspectionThresholdMin ?? null,
        failureThresholdMin: catalog.failureThresholdMin ?? null,
        sealLifeLowMin: catalog.sealLifeLowMin,
        sealLifeHighMin: catalog.sealLifeHighMin,
        health: "nominal",
        alert: null,
      });
    }
  }

  const lifecycleById = new Map<string, LifecycleSnapshot>();
  for (const lc of snapshot?.lifecycles ?? []) {
    if (lc.removal_date || lc.archived_at) continue;
    lifecycleById.set(lc.installation_id, lc);
  }
  const pipelineById = new Map(pipelineParts.map((p) => [p.installation_id, p]));

  return Array.from(seedById.values()).map((seed) => {
    const lc = lifecycleById.get(seed.installationId);
    const pp = pipelineById.get(seed.installationId);

    const serial = lc?.serial_number || pp?.serial_number || seed.serialNumber;
    const installationDate = lc?.installation_date ?? pp?.installation_date;
    const runtime = pp?.active_runtime_minutes ?? lc?.active_runtime_minutes ?? seed.granularRuntimeMinutes;
    const stress = pp?.high_stress_minutes ?? lc?.high_stress_minutes ?? seed.highStressMinutes;
    const cumStress = pp?.cumulative_pressure_stress ?? lc?.cumulative_pressure_stress ?? seed.cumulativePressureStress;
    const mtbf = pp?.expected_mtbf_minutes || seed.expectedMtbfMinutes;
    const inspection = pp?.inspection_threshold_min ?? seed.inspectionThresholdMin;
    const failure = pp?.failure_threshold_min ?? seed.failureThresholdMin;

    const ceiling = failure ?? mtbf ?? null;
    const pct = ceiling != null ? runtime / Math.max(1, ceiling) : null;
    const health: PartStatus["health"] =
      (pp?.health as PartStatus["health"]) ??
      (failure && runtime >= failure
        ? "critical"
        : inspection && runtime >= inspection
          ? "watch"
          : pct != null && pct >= 0.85
            ? "critical"
            : pct != null && pct >= 0.6
              ? "watch"
              : "nominal");
    const alert: PartStatus["alert"] =
      pp?.alert ??
      (failure && runtime >= failure
        ? "failure"
        : inspection && runtime >= inspection
          ? "inspection"
          : null);

    return {
      ...seed,
      serialNumber: serial,
      installationDate,
      granularRuntimeMinutes: runtime,
      highStressMinutes: stress,
      cumulativePressureStress: cumStress,
      expectedMtbfMinutes: mtbf,
      inspectionThresholdMin: inspection ?? null,
      failureThresholdMin: failure ?? null,
      health,
      alert,
    };
  });
}

const DEFAULT_EQUIPMENT = "0091";

export default function Home() {
  const searchParams = useSearchParams();
  const equipmentId = searchParams.get("eq") ?? DEFAULT_EQUIPMENT;

  const live = useLiveLifecycles();

  const [pipelinePayload, setPipelinePayload] = useState<PipelinePayload | null>(null);
  const [pipelineLoaded, setPipelineLoaded] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/pipeline.json", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as PipelinePayload;
        if (cancelled) return;
        setPipelinePayload(json);
        setPipelineLoaded(true);
      } catch {
        // No pipeline yet — slots still render from snapshot.
      }
    }
    void load();
    const id = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const snapshot = (live.data as SnapshotResponse | null) ?? null;
  const pipelineParts = useMemo<PartRecord[]>(
    () => pipelinePayload?.parts ?? [],
    [pipelinePayload],
  );
  const fatigue: FatigueSample[] = pipelinePayload?.fatigue_series ?? [];
  const offWindows: WindowSpan[] = pipelinePayload?.off_windows ?? [];
  const highStress: WindowSpan[] = pipelinePayload?.high_stress_windows ?? [];
  const summary = pipelinePayload?.summary ?? null;
  const events = snapshot?.events ?? [];

  const parts = useMemo(
    () => buildPartStatuses(equipmentId, snapshot, pipelineParts),
    [equipmentId, snapshot, pipelineParts],
  );

  const selectedPart = useMemo(() => {
    if (selectedPartId) {
      const explicit = parts.find((p) => p.id === selectedPartId);
      if (explicit) return explicit;
    }
    return parts.find((p) => p.serialNumber) ?? parts[0];
  }, [parts, selectedPartId]);

  async function handleIngest() {
    await live.refresh();
    try {
      const res = await fetch("/pipeline.json", { cache: "no-store" });
      if (res.ok) {
        setPipelinePayload((await res.json()) as PipelinePayload);
        setPipelineLoaded(true);
      }
    } catch {
      // Pipeline refresh is best-effort.
    }
  }

  async function handleLogMaintenance(input: {
    event_type: "inspect" | "clean" | "off_maintenance";
    notes: string;
  }) {
    if (!selectedPart) return;
    const res = await fetch("/api/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installation_id: selectedPart.installationId,
        equipment_id: selectedPart.equipmentId,
        event_type: input.event_type,
        notes: input.notes || null,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    await live.refresh();
  }

  const missingParts = parts.filter((p) => p.isSerialized && !p.serialNumber);
  const installedParts = parts.filter((p) =>
    p.isSerialized ? !!p.serialNumber : true,
  );

  // Structural odometers — sorted by wear % (highest → lowest)
  const structuralParts = installedParts.filter((p) => p.isStructural);

  // All non-structural installed parts for the components grid
  const componentParts = installedParts.filter((p) => !p.isStructural);

  // Count parts that need attention
  const needsAttention = installedParts.filter(
    (p) => p.health === "critical" || p.alert === "failure",
  );

  return (
    <main className="min-h-screen bg-[#12100e] text-[#f0dfc0]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">

        {/* Status bar */}
        <StatusBar
          backend={live.backend}
          pipelineLoaded={pipelineLoaded}
          generatedAt={pipelinePayload?.generated_at ?? null}
          snapshotAt={live.lastUpdatedAt}
        />

        <DataIngestPanel onIngest={handleIngest} />

        {summary && <SummaryStrip summary={summary} />}

        {/* Parts needing attention banner */}
        {needsAttention.length > 0 && (
          <div className="flex items-center justify-between gap-4 border-2 border-[#cc3311]/50 bg-[#cc3311]/10 px-5 py-3.5">
            <p className="font-mono text-sm text-[#ff6644]">
              <span className="font-semibold">{needsAttention.length} part{needsAttention.length > 1 ? "s" : ""}</span>
              {" "}need{needsAttention.length === 1 ? "s" : ""} immediate attention.
            </p>
            <Link
              href={`/replace?eq=${equipmentId}`}
              className="shrink-0 border border-[#cc3311] bg-[#cc3311]/20 px-4 py-1.5 font-orbitron text-xs font-semibold uppercase tracking-wider text-[#ff6644] transition hover:bg-[#cc3311]/30"
            >
              Replace Part →
            </Link>
          </div>
        )}

        {/* Missing components banner */}
        {missingParts.length > 0 && (
          <div className="flex items-center justify-between gap-4 border-2 border-[#c85a10]/50 bg-[#c85a10]/10 px-5 py-3.5">
            <p className="font-mono text-sm text-[#e8a020]">
              <span className="font-semibold">{missingParts.length} slot{missingParts.length > 1 ? "s" : ""}</span>
              {" "}missing installed part{missingParts.length > 1 ? "s" : ""}.
            </p>
            <Link
              href={`/replace?eq=${equipmentId}`}
              className="shrink-0 border border-[#e8a020] bg-[#e8a020]/20 px-4 py-1.5 font-orbitron text-xs font-semibold uppercase tracking-wider text-[#e8a020] transition hover:bg-[#e8a020]/30"
            >
              Install Part →
            </Link>
          </div>
        )}

        {/* Process flow */}
        <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
          <h2 className="mb-3 font-orbitron text-sm font-semibold uppercase tracking-widest text-[#e8a020]">
            C55 Sequential Process Flow
          </h2>
          <SequentialFlowchart
            parts={parts}
            selectedId={selectedPart?.id ?? ""}
            onSelect={setSelectedPartId}
          />
        </section>

        {/* Sensor / fatigue chart */}
        <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-orbitron text-sm font-semibold uppercase tracking-widest text-[#e8a020]">
              Fatigue Visualization
            </h2>
            <p className="font-mono text-xs text-[#5a4a38]">
              P01 pressure + rolling 10-min σ — correlates high pulsation with HP-thread weephole risk.
            </p>
          </div>
          <FatigueChart
            series={fatigue}
            highStress={highStress}
            offWindows={offWindows}
            parts={pipelineParts}
            runs={pipelinePayload?.runs}
          />
        </section>

        {/* Seal temperature slope */}
        <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-orbitron text-sm font-semibold uppercase tracking-widest text-[#c85a10]">
              Seal Temperature Slope
            </h2>
            <p className="font-mono text-xs text-[#5a4a38]">
              Max dT/dt across T01–T03 · x-axis = cumulative P01 active runtime
            </p>
          </div>
          <TemperatureChart series={fatigue} />
        </section>

        {/* Structural Odometers — sorted highest % → lowest */}
        {structuralParts.length > 0 && (
          <SubassemblyGrid
            title="Structural Odometers"
            subtitle="Sorted highest wear % → lowest · click row to log maintenance"
            parts={structuralParts}
            selectedId={selectedPart?.id ?? ""}
            onSelect={setSelectedPartId}
            sortByPct
          />
        )}

        {/* All sub-components by zone / type / orientation */}
        {componentParts.length > 0 && (
          <SubassemblyGrid
            title="Sub-components"
            subtitle="Cluster · Pump · Homogenizer · Manifold"
            parts={componentParts}
            selectedId={selectedPart?.id ?? ""}
            onSelect={setSelectedPartId}
          />
        )}

        {/* Maintenance log */}
        <MaintenanceLogPanel
          events={events}
          selectedInstallationId={selectedPart?.installationId ?? null}
          onLog={handleLogMaintenance}
        />

      </div>
    </main>
  );
}

function StatusBar({
  backend,
  pipelineLoaded,
  generatedAt,
  snapshotAt,
}: {
  backend: "supabase" | "local-json" | null;
  pipelineLoaded: boolean;
  generatedAt: string | null;
  snapshotAt: string | null;
}) {
  const backendLabel =
    backend === "supabase"
      ? "Supabase (live)"
      : backend === "local-json"
        ? "Local JSON"
        : "connecting…";

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border border-[#2e2820] bg-[#1c1814] px-4 py-2.5 font-mono text-xs text-[#5a4a38]">
      <span>
        Backend:{" "}
        <span className={backend === "supabase" ? "text-[#6ab04c]" : "text-[#8a7a60]"}>
          {backendLabel}
        </span>
      </span>
      {snapshotAt && (
        <span>
          Snapshot:{" "}
          <span className="text-[#8a7a60]">{new Date(snapshotAt).toLocaleTimeString()}</span>
        </span>
      )}
      {pipelineLoaded && generatedAt && (
        <span>
          Pipeline:{" "}
          <span className="text-[#8a7a60]">{new Date(generatedAt).toLocaleTimeString()}</span>
        </span>
      )}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: NonNullable<PipelinePayload["summary"]> }) {
  return (
    <section className="grid gap-3 border-2 border-[#2e2820] bg-[#1c1814] p-4 sm:grid-cols-2 lg:grid-cols-4">
      <KPI label="Active Runtime" value={`${summary.active_minutes_total} min`} accent="text-[#e8a020]" />
      <KPI label="High-Stress (σ > 2 kpsi)" value={`${summary.high_stress_minutes_total} min`} accent="text-[#c85a10]" />
      <KPI label="Off / Maintenance" value={`${summary.off_minutes_total} min`} accent="text-[#8a7a60]" />
      <KPI label="Out-of-Band (>30 kpsi)" value={`${summary.out_of_band_minutes} min`} accent="text-[#cc3311]" />
    </section>
  );
}

function KPI({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="border border-[#2e2820] bg-[#0e0c0a] p-3">
      <p className="font-orbitron text-[10px] uppercase tracking-widest text-[#4a3c28]">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}
