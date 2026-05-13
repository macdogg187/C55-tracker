"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

type Tab = { label: string; href: string; noEq?: boolean };

const TABS: Tab[] = [
  { label: "Dashboard", href: "/" },
  { label: "Replace Part", href: "/replace" },
  { label: "Predictions", href: "/predict" },
  { label: "History", href: "/history" },
  { label: "Glossary", href: "/glossary", noEq: true },
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
    <nav className="sticky top-0 z-40 border-b-2 border-[#e8a020] bg-[#0e0c0a]">
      <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between gap-4 px-5 py-2.5 lg:px-8">
        <div className="flex items-center gap-1">
          {/* Logo */}
          <div className="mr-5 hidden shrink-0 sm:block">
            <div className="font-orbitron text-xs font-bold uppercase tracking-[0.22em] text-[#e8a020]">
              C55 Tracker
            </div>
            <div className="text-[9px] uppercase tracking-[0.3em] text-[#5a4a38]">
              Mission Control
            </div>
          </div>

          {/* Nav tabs */}
          {TABS.map((tab) => {
            const isActive = pathname === tab.href;
            const href = tab.noEq ? tab.href : `${tab.href}?eq=${eq}`;
            return (
              <Link
                key={tab.href}
                href={href}
                className={`px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] transition-colors font-orbitron ${
                  isActive
                    ? "bg-[#e8a020] text-[#0e0c0a]"
                    : "text-[#8a7a60] hover:bg-[#2e2820] hover:text-[#e8a020]"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>

        {/* Equipment selector */}
        <select
          value={eq}
          onChange={handleEqChange}
          className="border border-[#e8a020] bg-[#1c1814] px-3 py-1.5 text-xs text-[#e8a020] font-orbitron uppercase tracking-wider focus:outline-none focus:ring-1 focus:ring-[#e8a020]"
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
