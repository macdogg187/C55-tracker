"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  buildSeedPartStatuses,
  type PartStatus,
} from "@/lib/dashboard-data";
import {
  PART_CATALOG,
  type FailureMode,
} from "@/lib/parts-catalog";
import type {
  FatigueSample,
  PartRecord,
  PipelinePayload,
  WindowSpan,
} from "@/lib/analytics";
import { useLiveLifecycles } from "@/lib/use-live-lifecycles";
import { SequentialFlowchart } from "./components/SequentialFlowchart";
import { FatigueChart } from "./components/FatigueChart";
import { PartCard } from "./components/PartCard";
import { ReplacePartDialog } from "./components/ReplacePartDialog";
import { MaintenanceLogPanel } from "./components/MaintenanceLogPanel";

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

type IngestSummary = {
  fileName: string;
  rowCount: number;
  headers: string[];
  inferredOffWindows: number;
};

// Merge the snapshot's slots+active-lifecycles into the canonical seed list
// so unfilled slots still render. Then layer the pipeline.json analytics on top.
function buildPartStatuses(
  equipmentId: string,
  snapshot: SnapshotResponse | null,
  pipelineParts: PartRecord[],
): PartStatus[] {
  const seedFromCatalog = buildSeedPartStatuses(equipmentId);
  const seedById = new Map(seedFromCatalog.map((p) => [p.installationId, p]));

  // Add slots that exist in the snapshot but aren't in the local catalog
  // (e.g. equipment 0938 / 0198 if the user switches lines).
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
        zone: slot.zone,
        orientation: slot.orientation,
        sequenceOrder: slot.sequence_order,
        serialNumber: "",
        granularRuntimeMinutes: 0,
        highStressMinutes: 0,
        cumulativePressureStress: 0,
        expectedMtbfMinutes: catalog.expectedMtbfMinutes ?? 12000,
        inspectionThresholdMin: catalog.inspectionThresholdMin ?? null,
        failureThresholdMin: catalog.failureThresholdMin ?? null,
        sealLifeLowMin: catalog.sealLifeLowMin,
        sealLifeHighMin: catalog.sealLifeHighMin,
        health: "nominal",
        alert: null,
      });
    }
  }

  // Index active lifecycles + pipeline records by installation_id
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
    const runtime = pp?.active_runtime_minutes
      ?? lc?.active_runtime_minutes
      ?? seed.granularRuntimeMinutes;
    const stress = pp?.high_stress_minutes ?? lc?.high_stress_minutes ?? seed.highStressMinutes;
    const cumStress = pp?.cumulative_pressure_stress
      ?? lc?.cumulative_pressure_stress
      ?? seed.cumulativePressureStress;
    const mtbf = pp?.expected_mtbf_minutes || seed.expectedMtbfMinutes;
    const inspection = pp?.inspection_threshold_min ?? seed.inspectionThresholdMin;
    const failure = pp?.failure_threshold_min ?? seed.failureThresholdMin;

    const ceiling = failure ?? mtbf;
    const pct = runtime / Math.max(1, ceiling);
    const health: PartStatus["health"] =
      (pp?.health as PartStatus["health"]) ??
      (failure && runtime >= failure
        ? "critical"
        : inspection && runtime >= inspection
          ? "watch"
          : pct >= 0.85
            ? "critical"
            : pct >= 0.6
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
  const live = useLiveLifecycles();

  const [equipmentId, setEquipmentId] = useState(DEFAULT_EQUIPMENT);
  const [pipelinePayload, setPipelinePayload] = useState<PipelinePayload | null>(null);
  const [pipelineLoaded, setPipelineLoaded] = useState(false);
  const [selectedPartId, setSelectedPartId] = useState<string>("");
  const [ingestSummary, setIngestSummary] = useState<IngestSummary | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  // Pipeline.json (analytics) — refreshes whenever the watcher rewrites it.
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
        // No pipeline yet — that's OK, we still render slots from the snapshot.
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
  const equipmentList = snapshot?.equipment ?? [];

  const parts = useMemo(
    () => buildPartStatuses(equipmentId, snapshot, pipelineParts),
    [equipmentId, snapshot, pipelineParts],
  );

  // Effective selection: user pick if it still exists, otherwise first
  // installed part, otherwise first slot. Computed (no setState) so we don't
  // trigger cascading renders from an effect.
  const selectedPart = useMemo(() => {
    if (selectedPartId) {
      const explicit = parts.find((p) => p.id === selectedPartId);
      if (explicit) return explicit;
    }
    return parts.find((p) => p.serialNumber) ?? parts[0];
  }, [parts, selectedPartId]);

  function handleCsvUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const headers = lines[0].split(",").map((h) => h.trim());
      const rows = lines.slice(1);
      const inferredOffWindows = rows.filter((r) => r.includes(",,") || r.includes("NaN")).length;
      setIngestSummary({ fileName: file.name, headers, rowCount: rows.length, inferredOffWindows });
    };
    reader.readAsText(file);
  }

  async function handleReplace(entry: {
    installationId: string;
    newSerial: string;
    failureMode: FailureMode;
    notes: string;
    timestamp: string;
  }) {
    setReplaceError(null);
    try {
      const res = await fetch("/api/lifecycle/replace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: entry.installationId,
          new_serial: entry.newSerial,
          failure_mode: entry.failureMode,
          notes: entry.notes || undefined,
          timestamp: entry.timestamp,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setReplaceOpen(false);
      await live.refresh();
    } catch (err) {
      setReplaceError((err as Error).message);
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

  const installedParts = parts.filter((p) => p.serialNumber);
  const consumables = installedParts.filter((p) => p.isConsumable);
  const structural = installedParts.filter((p) => p.isStructural);

  return (
    <main className="min-h-screen bg-[#030711] text-zinc-100">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">
        <Header
          equipmentId={equipmentId}
          equipmentList={equipmentList}
          onEquipmentChange={setEquipmentId}
          backend={live.backend}
          pipelineLoaded={pipelineLoaded}
          generatedAt={pipelinePayload?.generated_at ?? null}
          snapshotAt={live.lastUpdatedAt}
          onCsvUpload={handleCsvUpload}
        />

        {summary && <SummaryStrip summary={summary} />}

        <section className="rounded-2xl border border-cyan-900/40 bg-gradient-to-b from-slate-900 to-[#04080f] p-5">
          <h2 className="mb-3 text-base font-semibold text-zinc-100">
            C55 Sequential Process Flow
          </h2>
          <SequentialFlowchart
            parts={parts}
            selectedId={selectedPart?.id ?? ""}
            onSelect={setSelectedPartId}
          />
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-100">
              Fatigue Visualization
            </h2>
            <p className="text-xs text-zinc-400">
              Cumulative runtime overlay vs rolling stdev of P01 — highlights
              the correlation between high pulsation and HP-thread weephole risk.
            </p>
          </div>
          <FatigueChart series={fatigue} highStress={highStress} offWindows={offWindows} />
        </section>

        {ingestSummary && (
          <section className="rounded-2xl border border-emerald-900/45 bg-emerald-950/20 p-4 text-sm">
            <p className="font-medium text-emerald-300">
              CSV Ingestion Preview · {ingestSummary.fileName}
            </p>
            <p className="mt-1 text-emerald-100">
              Parsed {ingestSummary.rowCount} rows · {ingestSummary.headers.length} columns ·{" "}
              {ingestSummary.inferredOffWindows} suspected off-window rows.
            </p>
            <p className="mt-1 text-emerald-200/90">
              Detected: {ingestSummary.headers.join(", ")}
            </p>
            <p className="mt-1 text-emerald-300/80">
              Drop the file into the watched <code className="font-mono">inbox/</code> folder
              (or run <code className="font-mono">python data_pipeline.py</code>) to fully merge
              into the database.
            </p>
          </section>
        )}

        {selectedPart && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-widest text-cyan-400">Focused</p>
                <h2 className="text-lg font-semibold text-zinc-100">
                  {selectedPart.partName}{" "}
                  <span className="font-mono text-sm text-zinc-500">
                    {selectedPart.installationId}
                  </span>
                </h2>
                {replaceError && (
                  <p className="mt-1 text-xs text-rose-300">Replace failed: {replaceError}</p>
                )}
              </div>
              <button
                onClick={() => setReplaceOpen(true)}
                disabled={!selectedPart.serialNumber}
                title={
                  selectedPart.serialNumber
                    ? "Archive the current lifecycle and reset the odometer"
                    : "Slot is empty — replace requires an active lifecycle"
                }
                className="rounded-md border border-cyan-600 bg-cyan-700/30 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-700/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Replace Part
              </button>
            </div>
            <ReplacePartDialog
              part={selectedPart}
              open={replaceOpen}
              onClose={() => setReplaceOpen(false)}
              onSubmit={handleReplace}
            />
          </section>
        )}

        <MaintenanceLogPanel
          events={events}
          selectedInstallationId={selectedPart?.installationId ?? null}
          onLog={handleLogMaintenance}
        />

        {structural.length > 0 && (
          <PartGrid title="Structural Odometers" subtitle="Cumulative active runtime · alert tiers">
            {structural.map((p) => (
              <PartCard
                key={p.id}
                part={p}
                selected={selectedPart?.id === p.id}
                onSelect={() => setSelectedPartId(p.id)}
              />
            ))}
          </PartGrid>
        )}

        {consumables.length > 0 && (
          <PartGrid title="Consumables" subtitle="Seals · Ball Seats · CV Balls · Springs · 800–1200 min life">
            {consumables.map((p) => (
              <PartCard
                key={p.id}
                part={p}
                selected={selectedPart?.id === p.id}
                onSelect={() => setSelectedPartId(p.id)}
              />
            ))}
          </PartGrid>
        )}

        {installedParts.length > 0 && (
          <PartGrid title="All Installed Parts" subtitle="Granular runtime vs MTBF / failure thresholds">
            {installedParts.map((p) => (
              <PartCard
                key={p.id}
                part={p}
                selected={selectedPart?.id === p.id}
                onSelect={() => setSelectedPartId(p.id)}
              />
            ))}
          </PartGrid>
        )}
      </div>
    </main>
  );
}

function Header({
  equipmentId,
  equipmentList,
  onEquipmentChange,
  backend,
  pipelineLoaded,
  generatedAt,
  snapshotAt,
  onCsvUpload,
}: {
  equipmentId: string;
  equipmentList: { equipment_id: string; display_name: string }[];
  onEquipmentChange: (id: string) => void;
  backend: "supabase" | "local-json" | null;
  pipelineLoaded: boolean;
  generatedAt: string | null;
  snapshotAt: string | null;
  onCsvUpload: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const equipmentOptions =
    equipmentList.length > 0
      ? equipmentList
      : [
          { equipment_id: "0091", display_name: "C55 Equipment 0091" },
          { equipment_id: "0938", display_name: "C55 Equipment 0938" },
          { equipment_id: "0198", display_name: "C55 Equipment 0198" },
        ];

  const backendLabel =
    backend === "supabase"
      ? "Supabase (live)"
      : backend === "local-json"
        ? "Local JSON (file-watched)"
        : "loading…";

  return (
    <section className="rounded-2xl border border-cyan-900/40 bg-gradient-to-b from-slate-900 to-[#04080f] p-6 shadow-[0_0_40px_rgba(6,182,212,0.15)]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-400">
            Predictive Maintenance Cockpit
          </p>
          <h1 className="text-2xl font-semibold text-zinc-100 lg:text-3xl">
            C55 Homogenizer · Unified Tracker
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            Backend: <span className="text-zinc-300">{backendLabel}</span>
            {snapshotAt && <> · snapshot {new Date(snapshotAt).toLocaleTimeString()}</>}
            {pipelineLoaded && generatedAt && (
              <> · pipeline {new Date(generatedAt).toLocaleTimeString()}</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={equipmentId}
            onChange={(e) => onEquipmentChange(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
          >
            {equipmentOptions.map((e) => (
              <option key={e.equipment_id} value={e.equipment_id}>
                {e.display_name}
              </option>
            ))}
          </select>
          <label className="inline-flex cursor-pointer items-center gap-3 rounded-lg border border-cyan-800/60 bg-cyan-900/20 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-800/25">
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onCsvUpload} />
            Drop VantagePoint CSV
          </label>
        </div>
      </div>
    </section>
  );
}

function SummaryStrip({ summary }: { summary: NonNullable<PipelinePayload["summary"]> }) {
  return (
    <section className="grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <KPI label="Active Runtime" value={`${summary.active_minutes_total} min`} accent="text-cyan-300" />
      <KPI label="High-Stress (σ > 2 kpsi)" value={`${summary.high_stress_minutes_total} min`} accent="text-amber-300" />
      <KPI label="Off / Maintenance" value={`${summary.off_minutes_total} min`} accent="text-zinc-300" />
      <KPI label="Out-of-Band (>26 kpsi)" value={`${summary.out_of_band_minutes} min`} accent="text-rose-300" />
    </section>
  );
}

function KPI({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <p className="text-[10px] uppercase tracking-widest text-zinc-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${accent}`}>{value}</p>
    </div>
  );
}

function PartGrid({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between">
        <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}
