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
    <section className="border-2 border-[#2e2820] bg-[#1c1814] p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-orbitron text-sm font-semibold uppercase tracking-widest text-[#e8a020]">Maintenance Log</h2>
        <p className="font-mono text-xs text-[#5a4a38]">
          {selectedInstallationId
            ? `Filtered: ${selectedInstallationId}`
            : "Most recent across the line"}
        </p>
      </div>

      <form
        onSubmit={submit}
        className="mb-4 grid gap-2 border border-[#2e2820] bg-[#0e0c0a] p-3 text-xs sm:grid-cols-[140px_1fr_auto] sm:items-center"
      >
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as typeof eventType)}
          className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] focus:border-[#e8a020] focus:outline-none"
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
          className="border border-[#4a3c28] bg-[#1c1814] px-2 py-1.5 font-mono text-[#f0dfc0] placeholder-[#4a3c28] focus:border-[#e8a020] focus:outline-none"
        />
        <button
          type="submit"
          disabled={submitting || !selectedInstallationId}
          className="border border-[#e8a020] bg-[#1c1814] px-3 py-1.5 font-orbitron text-xs font-semibold uppercase tracking-wider text-[#e8a020] transition hover:bg-[#2e2820] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Logging…" : "Log Event"}
        </button>
      </form>
      {error && <p className="mb-3 font-mono text-xs text-[#cc3311]">{error}</p>}

      {filtered.length === 0 ? (
        <p className="font-mono text-xs text-[#5a4a38]">No events logged yet.</p>
      ) : (
        <ul className="divide-y divide-[#2e2820] border border-[#2e2820]">
          {filtered.map((e, i) => (
            <li key={e.id ?? `${e.detected_at}-${i}`} className="grid gap-1 p-3 font-mono text-xs sm:grid-cols-[120px_140px_1fr] sm:gap-3">
              <span className="text-[#5a4a38]">
                {new Date(e.detected_at).toLocaleString()}
              </span>
              <span className={`font-medium ${eventTypeColor(e.event_type)}`}>
                {e.event_type}
                {e.failure_mode && (
                  <span className="ml-1 text-[#e8a020]">· {e.failure_mode}</span>
                )}
              </span>
              <span className="text-[#8a7a60]">
                <span className="text-[#4a3c28]">{e.installation_id ?? "—"}</span>
                {e.notes && <span className="ml-2 text-[#f0dfc0]">{e.notes}</span>}
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
      return "text-[#cc3311]";
    case "failure_observation":
      return "text-[#c85a10]";
    case "data_integrity_alert":
      return "text-[#c85a10]";
    case "inspection_alert":
      return "text-[#e8a020]";
    case "high_stress_window":
      return "text-[#c85a10]";
    case "off_maintenance":
      return "text-[#8a7a60]";
    case "pass_detected":
      return "text-[#6ab04c]";
    default:
      return "text-[#e8a020]";
  }
}
