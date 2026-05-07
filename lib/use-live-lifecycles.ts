"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase/client";

// True only when the API route also has Supabase wired (server side). The
// server reports its backend in the snapshot response — we use *that* to
// decide whether realtime is meaningful, not just the presence of a public
// URL/key, because writes require the service-role key on the server.

type SnapshotResponse = {
  backend: "supabase" | "local-json";
  generated_at: string;
  equipment: unknown[];
  slots: unknown[];
  lifecycles: unknown[];
  events: unknown[];
};

export type UseLiveLifecyclesResult = {
  data: SnapshotResponse | null;
  backend: "supabase" | "local-json" | null;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  refresh: () => Promise<void>;
};

const LOCAL_POLL_MS = 3500;
const PIPELINE_POLL_MS = 8000;
const REALTIME_DEBOUNCE_MS = 250;

// Subscribes to live lifecycle/maintenance changes when Supabase is wired up,
// otherwise polls the API + the static pipeline.json fingerprint so the
// dashboard updates whenever the watcher rewrites the file.
export function useLiveLifecycles(): UseLiveLifecyclesResult {
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/lifecycles", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SnapshotResponse;
      setData(json);
      setLastUpdatedAt(json.generated_at);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — defer one tick so the effect body itself never triggers a
  // synchronous setState (satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    const id = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(id);
  }, [refresh]);

  // Debounced trigger for realtime change events
  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void refresh();
    }, REALTIME_DEBOUNCE_MS);
  }, [refresh]);

  const serverIsSupabase = data?.backend === "supabase";

  // Supabase realtime path — only when the server side is also using Supabase.
  useEffect(() => {
    const sb = supabase;
    if (!serverIsSupabase || !isSupabaseConfigured() || !sb) return;
    const channel = sb
      .channel("c55-tracker:lifecycles")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "part_lifecycle" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "maintenance_event" },
        scheduleRefresh,
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [scheduleRefresh, serverIsSupabase]);

  // Local-first fallback: poll the API + the pipeline.json fingerprint.
  useEffect(() => {
    if (serverIsSupabase) return;
    let cancelled = false;
    let lastSig: string | null = null;

    const poll = async () => {
      if (cancelled) return;
      // Cheap fingerprint check — HEAD on pipeline.json to detect watcher writes.
      try {
        const head = await fetch("/pipeline.json", { method: "HEAD", cache: "no-store" });
        const sig =
          head.headers.get("etag") ??
          head.headers.get("last-modified") ??
          head.headers.get("content-length");
        if (sig && sig !== lastSig) {
          lastSig = sig;
          await refresh();
        }
      } catch {
        // ignore — the API poll below still keeps state warm.
      }
    };

    const fast = setInterval(poll, LOCAL_POLL_MS);
    const slow = setInterval(() => {
      if (!cancelled) void refresh();
    }, PIPELINE_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(fast);
      clearInterval(slow);
    };
  }, [refresh, serverIsSupabase]);

  return {
    data,
    backend: data?.backend ?? null,
    loading,
    error,
    lastUpdatedAt,
    refresh,
  };
}
