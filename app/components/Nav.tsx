"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const TABS = [
  { label: "Dashboard", href: "/" },
  { label: "Replace Part", href: "/replace" },
  { label: "Predictions", href: "/predict" },
  { label: "History", href: "/history" },
];

const EQUIPMENT_OPTIONS = [
  { id: "0091", label: "C55 · 0091" },
  { id: "0938", label: "C55 · 0938" },
  { id: "0198", label: "C55 · 0198" },
];

export function Nav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const eq = searchParams.get("eq") ?? "0091";

  function handleEqChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("eq", e.target.value);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <nav className="sticky top-0 z-40 border-b border-zinc-800 bg-[#030711]/95 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between gap-4 px-5 py-2.5 lg:px-8">
        <div className="flex items-center gap-0.5">
          <span className="mr-4 hidden shrink-0 text-xs font-bold uppercase tracking-[0.22em] text-cyan-500 sm:block">
            C55 Tracker
          </span>
          {TABS.map((tab) => {
            const isActive = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={`${tab.href}?eq=${eq}`}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  isActive
                    ? "bg-cyan-900/40 text-cyan-300"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        <select
          value={eq}
          onChange={handleEqChange}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-cyan-700"
        >
          {EQUIPMENT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </nav>
  );
}
