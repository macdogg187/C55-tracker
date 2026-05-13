"use client";

import { useMemo, useState } from "react";

type MaintenanceEvent = {
  id?: string;
  installation_id: string | null;
  event_type: string;
  failure_mode: string | null;
  detected_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  source: string | null;
  notes: string | null;
};

type Props = {
  events: MaintenanceEvent[];
  selectedInstallationId: string | null;
  onLog: (input: {
    event_type: "inspect" | "clean" | "off_maintenance";
    notes: string;
  }) => Promise<void>;
};

export function MaintenanceLogPanel({
  events,
  selectedInstallationId,
  onLog,
}: Props) {
  const [eventType, setEventType] = useState<"inspect" | "clean" | "off_maintenance">("inspect");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const sorted = [...events].sort(
      (a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime(),
    );
    if (!selectedInstallationId) return sorted.slice(0, 10);
    return sorted.filter((e) => e.installation_id === selectedInstallationId).slice(0, 10);
  }, [events, selectedInstallationId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedInstallationId) {
      setError("Select a part above first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onLog({ event_type: eventType, notes: notes.trim() });
      setNotes("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-100">Maintenance Log</h2>
        <p className="text-xs text-zinc-500">
          {selectedInstallationId
            ? `Filtered by ${selectedInstallationId}`
            : "Most recent across the line"}
        </p>
      </div>

      <form
        onSubmit={submit}
        className="mb-4 grid gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-xs sm:grid-cols-[140px_1fr_auto] sm:items-center"
      >
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as typeof eventType)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100"
        >
          <option value="inspect">Inspection</option>
          <option value="clean">Clean</option>
          <option value="off_maintenance">Off / Maintenance</option>
        </select>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={
            selectedInstallationId
              ? `Notes for ${selectedInstallationId}…`
              : "Select a part above first"
          }
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100"
        />
        <button
          type="submit"
          disabled={submitting || !selectedInstallationId}
          className="rounded-md border border-cyan-600 bg-cyan-700/30 px-3 py-1.5 font-semibold text-cyan-100 transition hover:bg-cyan-700/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Logging…" : "Log Event"}
        </button>
      </form>
      {error && <p className="mb-3 text-xs text-rose-300">{error}</p>}

      {filtered.length === 0 ? (
        <p className="text-xs text-zinc-500">No events logged yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-900 rounded-xl border border-zinc-800">
          {filtered.map((e, i) => (
            <li key={e.id ?? `${e.detected_at}-${i}`} className="grid gap-1 p-3 text-xs sm:grid-cols-[120px_140px_1fr] sm:gap-3">
              <span className="font-mono text-zinc-400">
                {new Date(e.detected_at).toLocaleString()}
              </span>
              <span className={`font-medium ${eventTypeColor(e.event_type)}`}>
                {e.event_type}
                {e.failure_mode && (
                  <span className="ml-1 text-amber-300">· {e.failure_mode}</span>
                )}
              </span>
              <span className="text-zinc-300">
                <span className="font-mono text-zinc-500">{e.installation_id ?? "—"}</span>
                {e.notes && <span className="ml-2">{e.notes}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function eventTypeColor(t: string): string {
  switch (t) {
    case "replace":
    case "failure_alert":
      return "text-rose-300";
    case "failure_observation":
      return "text-amber-300";
    case "data_integrity_alert":
      return "text-orange-300";
    case "inspection_alert":
      return "text-amber-200";
    case "high_stress_window":
      return "text-amber-300";
    case "off_maintenance":
      return "text-zinc-300";
    case "pass_detected":
      return "text-emerald-300";
    default:
      return "text-cyan-300";
  }
}
