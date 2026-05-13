"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { HistoryRow } from "../api/history/route";

type SortKey = keyof Pick<
  HistoryRow,
  | "installation_id"
  | "part_name"
  | "serial_number"
  | "installation_date"
  | "removal_date"
  | "active_runtime_minutes"
  | "high_stress_minutes"
  | "failure_mode"
  | "status"
>;

type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "installation_id",       label: "Slot" },
  { key: "part_name",             label: "Part" },
  { key: "serial_number",         label: "Serial #" },
  { key: "installation_date",     label: "Installed" },
  { key: "removal_date",          label: "Removed" },
  { key: "active_runtime_minutes", label: "Runtime (min)", align: "right" },
  { key: "high_stress_minutes",   label: "High-Stress (min)", align: "right" },
  { key: "failure_mode",          label: "Failure Mode" },
  { key: "status",                label: "Status" },
];

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function fmtNum(n: number) {
  return n === 0 ? "—" : n.toLocaleString();
}

function rowMatchesSearch(row: HistoryRow, q: string): boolean {
  const lower = q.toLowerCase();
  return (
    row.installation_id.toLowerCase().includes(lower) ||
    row.part_name.toLowerCase().includes(lower) ||
    row.serial_number.toLowerCase().includes(lower) ||
    (row.failure_mode ?? "").toLowerCase().includes(lower) ||
    (row.notes ?? "").toLowerCase().includes(lower) ||
    row.equipment_id.toLowerCase().includes(lower)
  );
}

function compareRows(a: HistoryRow, b: HistoryRow, key: SortKey, dir: SortDir): number {
  let av: string | number | null;
  let bv: string | number | null;

  if (key === "active_runtime_minutes" || key === "high_stress_minutes") {
    av = a[key] as number;
    bv = b[key] as number;
    return dir === "asc" ? av - bv : bv - av;
  }

  av = (a[key] ?? "") as string;
  bv = (b[key] ?? "") as string;
  const cmp = av.localeCompare(bv);
  return dir === "asc" ? cmp : -cmp;
}

function exportCsv(rows: HistoryRow[]) {
  const headers = [
    "slot", "equipment", "part", "serial", "refurb",
    "installed", "removed", "runtime_min", "high_stress_min",
    "failure_mode", "notes", "status",
  ];
  const lines = rows.map((r) =>
    [
      r.installation_id,
      r.equipment_id,
      r.part_name,
      r.serial_number,
      r.is_refurb ? "yes" : "no",
      r.installation_date ? new Date(r.installation_date).toISOString() : "",
      r.removal_date ? new Date(r.removal_date).toISOString() : "",
      r.active_runtime_minutes,
      r.high_stress_minutes,
      r.failure_mode ?? "",
      (r.notes ?? "").replace(/,/g, ";"),
      r.status,
    ].join(","),
  );
  const blob = new Blob([[headers.join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mtbf-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#FAFAF5]" />}>
      <HistoryContent />
    </Suspense>
  );
}

function HistoryContent() {
  const searchParams = useSearchParams();
  const equipmentId = searchParams.get("eq") ?? "";

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("installation_date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [showOnlyEquipment, setShowOnlyEquipment] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/history", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { rows: HistoryRow[] };
        setRows(json.rows);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const filtered = useMemo(() => {
    let result = rows;
    if (showOnlyEquipment && equipmentId) {
      result = result.filter((r) => r.equipment_id === equipmentId);
    }
    if (query.trim()) {
      result = result.filter((r) => rowMatchesSearch(r, query));
    }
    return [...result].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [rows, query, sortKey, sortDir, showOnlyEquipment, equipmentId]);

  const activeCount  = filtered.filter((r) => r.status === "active").length;
  const archivedCount = filtered.filter((r) => r.status === "archived").length;

  return (
    <main className="min-h-screen bg-[#FAFAF5] text-[#1A1A16]">
      <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-5 py-6 lg:px-8">

        <div>
          <p className="font-barlow text-xs uppercase tracking-widest text-[#C04810]">Records</p>
          <h1 className="mt-1 font-barlow text-2xl font-semibold text-[#1A1A16]">MTBF History</h1>
          <p className="mt-1 text-sm text-[#787870]">
            All lifecycle records — historical Excel imports and in-app entries, active and archived.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#787870]">
              ⌕
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search slot, part, serial, failure mode…"
              className="w-full border border-[#7A7768] bg-[#F0EFE8] py-2 pl-8 pr-3 text-sm text-[#1A1A16] placeholder:text-[#7A7768] focus:border-[#C04810] focus:outline-none rounded-sm"
            />
          </div>

          {equipmentId && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[#4A4A42]">
              <input
                type="checkbox"
                checked={showOnlyEquipment}
                onChange={(e) => setShowOnlyEquipment(e.target.checked)}
                className="accent-[#C04810]"
              />
              Equipment {equipmentId} only
            </label>
          )}

          <div className="ml-auto flex items-center gap-3">
            <div className="flex gap-2 text-xs">
              <span className="border border-[#2B7A3E]/60 bg-[#2B7A3E]/10 px-2 py-0.5 text-[#2B7A3E] rounded-sm">
                {activeCount} active
              </span>
              <span className="border border-[#B0AD9E] bg-[#F0EFE8] px-2 py-0.5 text-[#787870] rounded-sm">
                {archivedCount} archived
              </span>
            </div>
            <button
              onClick={() => exportCsv(filtered)}
              disabled={filtered.length === 0}
              className="border border-[#7A7768] bg-[#F0EFE8] px-3 py-1.5 text-xs font-medium text-[#4A4A42] transition hover:border-[#4A4A42] hover:text-[#1A1A16] disabled:opacity-40 rounded-sm"
            >
              Export CSV
            </button>
          </div>
        </div>

        {loading && (
          <p className="py-12 text-center text-sm text-[#787870]">Loading records…</p>
        )}
        {error && (
          <p className="border border-[#A82020]/40 bg-[#A82020]/8 px-4 py-3 text-sm text-[#A82020] rounded-sm">
            Failed to load history: {error}
          </p>
        )}

        {!loading && !error && (
          <div className="overflow-x-auto border border-[#B0AD9E] rounded-sm">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-[#B0AD9E] bg-[#E5E3DA]">
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      onClick={() => toggleSort(col.key)}
                      className={`cursor-pointer select-none whitespace-nowrap px-4 py-3 font-barlow text-[11px] font-semibold uppercase tracking-widest text-[#7A7768] hover:text-[#C04810] ${col.align === "right" ? "text-right" : "text-left"}`}
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-left font-barlow text-[11px] font-semibold uppercase tracking-widest text-[#7A7768]">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B0AD9E]">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length + 1} className="px-4 py-8 text-center text-sm text-[#787870]">
                      No records match your search.
                    </td>
                  </tr>
                ) : (
                  filtered.map((row) => (
                    <tr
                      key={row.id}
                      className={`transition hover:bg-[#E5E3DA]/60 ${
                        row.status === "active" ? "" : "opacity-60"
                      }`}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-[#4A4A42]">
                        {row.installation_id}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-[#1A1A16]">
                        {row.part_name || "—"}
                        {row.is_refurb && (
                          <span className="ml-1.5 bg-[#B8860B]/15 px-1 py-0.5 text-[9px] uppercase text-[#B8860B] rounded-sm">
                            refurb
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-[#4A4A42]">
                        {row.serial_number || "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-[#787870]">
                        {fmtDate(row.installation_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-[#787870]">
                        {fmtDate(row.removal_date)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs tabular-nums text-[#4A4A42]">
                        {fmtNum(row.active_runtime_minutes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs tabular-nums text-[#B8860B]">
                        {fmtNum(row.high_stress_minutes)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {row.failure_mode ? (
                          <span className="border border-[#B0AD9E] bg-[#E5E3DA] px-2 py-0.5 text-xs text-[#4A4A42] rounded-sm">
                            {row.failure_mode}
                          </span>
                        ) : (
                          <span className="text-[#7A7768]">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {row.status === "active" ? (
                          <span className="border border-[#2B7A3E]/60 bg-[#2B7A3E]/10 px-2 py-0.5 font-barlow text-[10px] font-semibold uppercase text-[#2B7A3E] rounded-sm">
                            active
                          </span>
                        ) : (
                          <span className="border border-[#B0AD9E]/60 bg-[#E5E3DA] px-2 py-0.5 text-[10px] uppercase text-[#787870] rounded-sm">
                            archived
                          </span>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-2.5 text-xs text-[#787870]">
                        {row.notes || "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {filtered.length > 0 && (
              <div className="border-t border-[#B0AD9E] bg-[#E5E3DA] px-4 py-2 text-xs text-[#787870]">
                {filtered.length.toLocaleString()} records
                {rows.length !== filtered.length && ` of ${rows.length.toLocaleString()} total`}
              </div>
            )}
          </div>
        )}

      </div>
    </main>
  );
}
