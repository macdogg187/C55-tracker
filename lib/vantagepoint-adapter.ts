import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decodeTrendsBuffer } from "@/lib/trends-ingest";

// =============================================================================
// Live VantagePoint adapter — design-only until plant-floor protocol is
// confirmed. The interface is intentionally narrow so swapping OPC-UA for
// MQTT or Modbus only touches the adapter file, not the rest of the app.
//
// Concrete impls:
//   - MockAdapter   : replays a historical .csv/.txt file in real-time. Used
//                     by scripts/stream_worker.ts and tests.
//   - OpcUaAdapter  : stub — production impl needs the node-opcua dep + the
//                     plant's NodeId / endpoint URL.
// =============================================================================

export type LiveSample = {
  ts: number;          // unix ms (UTC)
  equipment_id: string;
  signal: string;      // 'P01' | 'P02' | 'T01'..'T05' | etc.
  value: number;
};

export type AdapterSubscriptionOptions = {
  equipmentId: string;
  signals?: string[];          // optional filter; default = all detected
  onSample: (s: LiveSample) => void;
  // Called on transport errors. The adapter decides whether to retry; the
  // worker just decides whether to surface the error to the dashboard.
  onError?: (err: Error) => void;
};

export interface VantagePointAdapter {
  readonly kind: "mock" | "opcua" | "modbus";
  subscribe(opts: AdapterSubscriptionOptions): Promise<{ stop: () => void }>;
  disconnect(): Promise<void>;
}

// --------------------------------------------------------------------------
// MockAdapter — replays a VantagePoint export at configurable speed. Used to
// validate the rest of the streaming pipeline without a real OPC-UA endpoint.
// --------------------------------------------------------------------------

export type MockAdapterConfig = {
  filePath: string;            // absolute or repo-relative
  speedMultiplier?: number;    // 1 = realtime, 60 = 1 min wall per 60 min file
  loop?: boolean;
};

export class MockAdapter implements VantagePointAdapter {
  readonly kind = "mock" as const;
  private aborted = false;
  private intervalIds: NodeJS.Timeout[] = [];

  constructor(private readonly cfg: MockAdapterConfig) {}

  async subscribe(opts: AdapterSubscriptionOptions): Promise<{ stop: () => void }> {
    const speed = this.cfg.speedMultiplier ?? 60;
    const absPath = path.isAbsolute(this.cfg.filePath)
      ? this.cfg.filePath
      : path.join(process.cwd(), this.cfg.filePath);
    const raw = await fs.readFile(absPath);
    const text = decodeTrendsBuffer(raw);

    // Lightweight inline parse — we just need (ts, signal -> value) rows.
    // We avoid pulling Papa Parse in here so the worker stays tiny.
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const headerIdx = lines.findIndex(
      (l) => /time|p01/i.test(l) && /,|\t/.test(l),
    );
    if (headerIdx < 0) throw new Error("mock adapter: no header row found");
    const delim = lines[headerIdx].includes("\t") ? "\t" : ",";
    const headers = lines[headerIdx].split(delim).map((h) => h.trim());
    const signalIdx: { signal: string; col: number }[] = [];
    headers.forEach((h, i) => {
      const m = h.match(/^(P0[12]|T0[1-5])/i);
      if (m) signalIdx.push({ signal: m[1].toUpperCase(), col: i });
    });
    const tsCol = headers.findIndex((h) => /^(time|timestamp|datetime)/i.test(h));
    if (tsCol < 0) throw new Error("mock adapter: no timestamp column");

    const signalFilter = opts.signals ? new Set(opts.signals.map((s) => s.toUpperCase())) : null;
    const dataLines = lines.slice(headerIdx + 1);

    const start = Date.now();
    const firstTs = parseFlexibleDate(dataLines[0]?.split(delim)[tsCol] ?? "");
    if (!Number.isFinite(firstTs)) {
      throw new Error("mock adapter: first row has no parseable timestamp");
    }

    let i = 0;
    const tick = async () => {
      while (!this.aborted && i < dataLines.length) {
        const row = dataLines[i].split(delim);
        const fileTs = parseFlexibleDate(row[tsCol]);
        if (!Number.isFinite(fileTs)) {
          i++;
          continue;
        }
        const wallDelay = (fileTs - firstTs) / speed - (Date.now() - start);
        if (wallDelay > 0) {
          await new Promise((r) => setTimeout(r, Math.min(wallDelay, 30_000)));
        }
        if (this.aborted) return;
        for (const { signal, col } of signalIdx) {
          if (signalFilter && !signalFilter.has(signal)) continue;
          const raw = row[col];
          const n = raw === undefined ? NaN : Number(raw);
          if (!Number.isFinite(n)) continue;
          opts.onSample({
            ts: fileTs,
            equipment_id: opts.equipmentId,
            signal,
            value: n,
          });
        }
        i++;
      }
      if (!this.aborted && this.cfg.loop) {
        i = 0;
        void tick();
      }
    };
    void tick().catch((err) => opts.onError?.(err as Error));

    return {
      stop: () => {
        this.aborted = true;
      },
    };
  }

  async disconnect(): Promise<void> {
    this.aborted = true;
    for (const id of this.intervalIds) clearTimeout(id);
  }
}

function parseFlexibleDate(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return NaN;
  const m = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,4}))?\s*(AM|PM)?$/i,
  );
  if (m) {
    const month = +m[1];
    const day = +m[2];
    let year = +m[3];
    if (year < 100) year += 2000;
    let hour = +m[4];
    const min = +m[5];
    const sec = +m[6];
    const ms = m[7] ? +((m[7] + "000").slice(0, 3)) : 0;
    const meridiem = m[8]?.toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return Date.UTC(year, month - 1, day, hour, min, sec, ms);
  }
  return new Date(trimmed).getTime();
}

// --------------------------------------------------------------------------
// OpcUaAdapter — production stub.
//
// Wiring (when ready):
//   1. `npm i node-opcua node-opcua-client` (devDep ok)
//   2. configure VANTAGEPOINT_OPC_URL + VANTAGEPOINT_OPC_NODE_IDS in env
//   3. flesh out subscribe() to call session.createSubscription2 +
//      monitor a NodeId per signal, mapping samples into LiveSample
//
// We export the shell so callers can `instanceof OpcUaAdapter` once the
// integration is live without changing the worker code.
// --------------------------------------------------------------------------

export type OpcUaAdapterConfig = {
  endpointUrl: string;
  nodeIds: Record<string, string>; // signal name -> OPC-UA NodeId
};

export class OpcUaAdapter implements VantagePointAdapter {
  readonly kind = "opcua" as const;
  constructor(_cfg: OpcUaAdapterConfig) {
    void _cfg;
  }
  async subscribe(_opts: AdapterSubscriptionOptions): Promise<{ stop: () => void }> {
    throw new Error(
      "OpcUaAdapter is a design stub — install node-opcua and implement subscribe() against the plant endpoint",
    );
  }
  async disconnect(): Promise<void> {
    return;
  }
}

// --------------------------------------------------------------------------
// In-process event bus used by the worker to fan samples out to SSE clients.
// One bus per Node process (Next.js dev server / production node instance).
// --------------------------------------------------------------------------

type Listener = (s: LiveSample) => void;
const listeners = new Set<Listener>();
const recentBuffer: LiveSample[] = [];
const RECENT_BUFFER_LIMIT = 600; // ~10 min @ 1 Hz

export function publishLiveSample(s: LiveSample): void {
  recentBuffer.push(s);
  if (recentBuffer.length > RECENT_BUFFER_LIMIT) {
    recentBuffer.splice(0, recentBuffer.length - RECENT_BUFFER_LIMIT);
  }
  for (const l of listeners) {
    try {
      l(s);
    } catch {
      // Drop bad listeners silently so one client can't take down the bus.
    }
  }
}

export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentLiveSamples(): LiveSample[] {
  return recentBuffer.slice();
}
