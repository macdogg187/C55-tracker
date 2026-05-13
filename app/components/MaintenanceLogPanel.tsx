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
    <section className="border border-[#B0AD9E] bg-[#F0EFE8] p-5 rounded-sm shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-barlow text-sm font-semibold uppercase tracking-widest text-[#C04810]">Maintenance Log</h2>
        <p className="text-xs text-[#787870]">
          {selectedInstallationId
            ? `Filtered: ${selectedInstallationId}`
            : "Most recent across the line"}
        </p>
      </div>

      <form
        onSubmit={submit}
        className="mb-4 grid gap-2 border border-[#B0AD9E] bg-[#E5E3DA] p-3 text-xs rounded-sm sm:grid-cols-[140px_1fr_auto] sm:items-center"
      >
        <select
          value={eventType}
          onChange={(e) => setEventType(e.target.value as typeof eventType)}
          className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] focus:border-[#C04810] focus:outline-none rounded-sm"
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
          className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] placeholder:text-[#7A7768] focus:border-[#C04810] focus:outline-none rounded-sm"
        />
        <button
          type="submit"
          disabled={submitting || !selectedInstallationId}
          className="border border-[#C04810] bg-[#F0EFE8] px-3 py-1.5 font-barlow text-xs font-semibold uppercase tracking-wider text-[#C04810] transition hover:bg-[#E5E3DA] disabled:cursor-not-allowed disabled:opacity-40 rounded-sm"
        >
          {submitting ? "Logging…" : "Log Event"}
        </button>
      </form>
      {error && <p className="mb-3 text-xs text-[#A82020]">{error}</p>}

      {filtered.length === 0 ? (
        <p className="text-xs text-[#787870]">No events logged yet.</p>
      ) : (
        <ul className="divide-y divide-[#B0AD9E] border border-[#B0AD9E] rounded-sm overflow-hidden">
          {filtered.map((e, i) => (
            <li key={e.id ?? `${e.detected_at}-${i}`} className="grid gap-1 p-3 text-xs sm:grid-cols-[120px_140px_1fr] sm:gap-3 bg-[#E5E3DA]">
              <span className="text-[#787870]">
                {new Date(e.detected_at).toLocaleString()}
              </span>
              <span className={`font-medium ${eventTypeColor(e.event_type)}`}>
                {e.event_type}
                {e.failure_mode && (
                  <span className="ml-1 text-[#C04810]">· {e.failure_mode}</span>
                )}
              </span>
              <span className="text-[#4A4A42]">
                <span className="text-[#7A7768]">{e.installation_id ?? "—"}</span>
                {e.notes && <span className="ml-2 text-[#1A1A16]">{e.notes}</span>}
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
      return "text-[#A82020]";
    case "failure_observation":
      return "text-[#B8860B]";
    case "data_integrity_alert":
      return "text-[#B8860B]";
    case "inspection_alert":
      return "text-[#C04810]";
    case "high_stress_window":
      return "text-[#B8860B]";
    case "off_maintenance":
      return "text-[#4A4A42]";
    case "pass_detected":
      return "text-[#2B7A3E]";
    default:
      return "text-[#C04810]";
  }
}
