"use client";

import { useState } from "react";
import type { PartStatus } from "@/lib/dashboard-data";
import { FAILURE_MODES, type FailureMode } from "@/lib/parts-catalog";

export type ReplacePartEntry = {
  installationId: string;
  newSerial: string;
  failureMode?: FailureMode | null;
  notes: string;
  timestamp: string;
};

export type ReportFailureEntry = {
  installationId: string;
  failureMode: FailureMode;
  notes: string;
  timestamp: string;
};

type Props = {
  part: PartStatus;
  open: boolean;
  mode?: "replace" | "report";
  onClose: () => void;
  onSubmit: (entry: ReplacePartEntry) => void;
  onReport?: (entry: ReportFailureEntry) => void;
};

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fromDatetimeLocal(local: string): string {
  const d = new Date(local);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function ReplacePartDialog({
  part,
  open,
  mode = "replace",
  onClose,
  onSubmit,
  onReport,
}: Props) {
  const [newSerial, setNewSerial] = useState("");
  const [failureMode, setFailureMode] = useState<FailureMode>("normal wear");
  const [notes, setNotes] = useState("");
  const [installDate, setInstallDate] = useState<string>(
    toDatetimeLocal(new Date().toISOString()),
  );

  if (!open) return null;

  const isReport = mode === "report";
  const isFreshInstall = !part.serialNumber && !isReport;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const timestamp = fromDatetimeLocal(installDate);
    if (isReport) {
      onReport?.({
        installationId: part.installationId,
        failureMode,
        notes: notes.trim(),
        timestamp,
      });
    } else {
      onSubmit({
        installationId: part.installationId,
        newSerial: newSerial.trim(),
        failureMode: isFreshInstall ? null : failureMode,
        notes: notes.trim(),
        timestamp,
      });
    }
    setNewSerial("");
    setNotes("");
    setFailureMode("normal wear");
    setInstallDate(toDatetimeLocal(new Date().toISOString()));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 border border-[#C04810] bg-[#FAFAF5] p-6 shadow-xl rounded-sm"
      >
        <header>
          <h3 className="font-barlow text-base font-semibold uppercase tracking-widest text-[#C04810]">
            {isReport ? "Report Failure" : isFreshInstall ? "Install Part" : "Replace Part"}
          </h3>
          <p className="mt-1 text-xs text-[#787870]">
            {isReport ? (
              <>
                Logs a failure observation for{" "}
                <span className="text-[#B8860B]">
                  {part.installationId}
                </span>{" "}
                without archiving the lifecycle.
              </>
            ) : isFreshInstall ? (
              <>
                Creates a new lifecycle for{" "}
                <span className="text-[#C04810]">
                  {part.installationId}
                </span>{" "}
                and starts the runtime odometer.
              </>
            ) : (
              <>
                Archives the current lifecycle and resets the odometer for{" "}
                <span className="text-[#C04810]">
                  {part.installationId}
                </span>
                .
              </>
            )}
          </p>
        </header>

        <div className="grid gap-3 text-xs">
          {!isFreshInstall && (
            <>
              <Row label="Outgoing serial number">
                <span className="text-[#1A1A16]">
                  {part.serialNumber || "—"}
                </span>
              </Row>
              <Row label="Active runtime captured">
                <span className="text-[#1A1A16]">
                  {part.granularRuntimeMinutes} min
                  {part.highStressMinutes > 0 && (
                    <span className="ml-2 text-[#B8860B]">
                      ({part.highStressMinutes} min high-stress)
                    </span>
                  )}
                </span>
              </Row>
            </>
          )}

          {!isReport && (
            <label className="flex flex-col gap-1">
              <span className="text-[#4A4A42]">
                {isFreshInstall ? "Installation date" : "Replacement date"}
                <span className="ml-1.5 text-[#7A7768]">(defaults to now · set earlier for backfills)</span>
              </span>
              <input
                type="datetime-local"
                value={installDate}
                max={toDatetimeLocal(new Date().toISOString())}
                onChange={(e) => setInstallDate(e.target.value)}
                className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] focus:border-[#C04810] focus:outline-none rounded-sm"
              />
            </label>
          )}

          {!isReport && !isFreshInstall && (
            <label className="flex flex-col gap-1">
              <span className="text-[#4A4A42]">Failure mode</span>
              <select
                value={failureMode}
                onChange={(e) => setFailureMode(e.target.value as FailureMode)}
                className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] focus:border-[#C04810] focus:outline-none rounded-sm"
              >
                {FAILURE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          {isReport && (
            <label className="flex flex-col gap-1">
              <span className="text-[#4A4A42]">Failure mode</span>
              <select
                value={failureMode}
                onChange={(e) => setFailureMode(e.target.value as FailureMode)}
                className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] focus:border-[#C04810] focus:outline-none rounded-sm"
              >
                {FAILURE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          {!isReport && (
            <label className="flex flex-col gap-1">
              <span className="text-[#4A4A42]">
                New serial number
                {part.isConsumable && (
                  <span className="ml-1 text-[#7A7768]">(optional for consumables)</span>
                )}
              </span>
              <input
                value={newSerial}
                onChange={(e) => setNewSerial(e.target.value)}
                required={!part.isConsumable && !isFreshInstall}
                placeholder={part.isConsumable ? "Leave blank if untracked" : "e.g. HPT-26-014"}
                className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] placeholder:text-[#7A7768] focus:border-[#C04810] focus:outline-none rounded-sm"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[#4A4A42]">Notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={
                isReport
                  ? "Weephole weep observed at left HP thread root; will monitor before replace."
                  : isFreshInstall
                    ? "New part sourced from batch lot 26-B."
                    : "Weephole leak observed at the HP thread root."
              }
              className="border border-[#7A7768] bg-[#F0EFE8] px-2 py-1.5 text-[#1A1A16] placeholder:text-[#7A7768] focus:border-[#C04810] focus:outline-none rounded-sm"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="border border-[#7A7768] px-3 py-1.5 text-xs text-[#4A4A42] hover:border-[#4A4A42] hover:text-[#1A1A16] rounded-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={
              isReport
                ? "border border-[#B8860B] bg-[#B8860B]/15 px-3 py-1.5 font-barlow text-xs font-semibold uppercase tracking-wider text-[#B8860B] hover:bg-[#B8860B]/25 rounded-sm"
                : "border border-[#C04810] bg-[#C04810]/15 px-3 py-1.5 font-barlow text-xs font-semibold uppercase tracking-wider text-[#C04810] hover:bg-[#C04810]/25 rounded-sm"
            }
          >
            {isReport
              ? "Log Failure Observation"
              : isFreshInstall
                ? "Log Installation"
                : "Archive & Reset Odometer"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border border-[#B0AD9E] bg-[#E5E3DA] px-2.5 py-1.5 rounded-sm">
      <span className="text-[#4A4A42]">{label}</span>
      {children}
    </div>
  );
}
