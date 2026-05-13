/**
 * Live telemetry stream worker.
 *
 * Runs OUTSIDE the Next.js request lifecycle so it can hold a long-lived
 * adapter connection. Tumbling-window aggregator + dashboard fan-out via
 * the in-process event bus in lib/vantagepoint-adapter.ts.
 *
 * Usage:
 *   npx tsx scripts/stream_worker.ts --adapter mock \
 *     --file vantagepoint_sensor.csv --equipment 0091 --speed 60
 *
 *   npx tsx scripts/stream_worker.ts --adapter opcua  # once wired up
 *
 * Tumbling-window strategy:
 *   - buffer samples by signal in memory
 *   - every WINDOW_SECONDS, snapshot the buffer + clear, run it through
 *     computeTrendsMetrics with a single-row lifecycleWindow shim, and
 *     call store.applyTrendsIngest so the dashboard sees the rollup.
 *
 * NOTE: This is a developer-facing tool. Production deploys should
 * supervise it via systemd / pm2 / kubernetes.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { getLifecycleStore } from "@/lib/lifecycle-store";
import { computeTrendsMetrics } from "@/lib/trends-ingest";
import {
  MockAdapter,
  OpcUaAdapter,
  publishLiveSample,
  type LiveSample,
  type VantagePointAdapter,
} from "@/lib/vantagepoint-adapter";

type Args = {
  adapter: "mock" | "opcua";
  file?: string;
  equipment: string;
  windowSeconds: number;
  speed: number;
};

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      adapter: { type: "string", default: "mock" },
      file: { type: "string" },
      equipment: { type: "string", default: "0091" },
      "window-seconds": { type: "string", default: "60" },
      speed: { type: "string", default: "60" },
    },
    allowPositionals: false,
  });
  return {
    adapter: (values.adapter ?? "mock") as Args["adapter"],
    file: values.file,
    equipment: values.equipment ?? "0091",
    windowSeconds: Number(values["window-seconds"] ?? "60"),
    speed: Number(values.speed ?? "60"),
  };
}

function buildAdapter(args: Args): VantagePointAdapter {
  if (args.adapter === "mock") {
    const file = args.file
      ?? (process.env.MOCK_ADAPTER_FILE
        ?? path.join("vantagepoint_sensor.csv"));
    return new MockAdapter({ filePath: file, speedMultiplier: args.speed });
  }
  if (args.adapter === "opcua") {
    return new OpcUaAdapter({
      endpointUrl: process.env.VANTAGEPOINT_OPC_URL ?? "opc.tcp://localhost:4840",
      nodeIds: {
        P01: process.env.VP_OPC_P01 ?? "",
        P02: process.env.VP_OPC_P02 ?? "",
        T01: process.env.VP_OPC_T01 ?? "",
        T02: process.env.VP_OPC_T02 ?? "",
        T03: process.env.VP_OPC_T03 ?? "",
        T04: process.env.VP_OPC_T04 ?? "",
        T05: process.env.VP_OPC_T05 ?? "",
      },
    });
  }
  throw new Error(`unknown adapter ${args.adapter}`);
}

// Tumbling window buffer keyed by signal -> ordered (ts, value) lists.
class WindowBuffer {
  private rows: LiveSample[] = [];
  add(s: LiveSample) {
    this.rows.push(s);
  }
  size(): number {
    return this.rows.length;
  }
  drain(): LiveSample[] {
    const out = this.rows;
    this.rows = [];
    return out;
  }
}

async function flushWindow(
  args: Args,
  buffer: WindowBuffer,
): Promise<void> {
  const samples = buffer.drain();
  if (samples.length === 0) return;

  // Pivot the long-form samples into the (times[], signals[][]) shape that
  // computeTrendsMetrics expects.
  const byTs = new Map<number, Record<string, number>>();
  for (const s of samples) {
    const row = byTs.get(s.ts) ?? {};
    row[s.signal] = s.value;
    byTs.set(s.ts, row);
  }
  const times = [...byTs.keys()].sort((a, b) => a - b);
  const signalNames = new Set<string>();
  for (const row of byTs.values()) for (const k of Object.keys(row)) signalNames.add(k);
  const signals: Record<string, number[]> = {};
  for (const sig of signalNames) signals[sig] = [];
  for (const t of times) {
    const row = byTs.get(t)!;
    for (const sig of signalNames) {
      const v = row[sig];
      signals[sig].push(v === undefined ? NaN : v);
    }
  }
  if (!signals.P01) {
    console.warn(
      `[stream-worker] window has no P01 samples — skipping rollup`,
    );
    return;
  }

  const parsed = {
    times,
    signals,
    signalsDetected: [...signalNames].sort(),
  };
  const result = computeTrendsMetrics(parsed, [], `live:${args.equipment}`);

  const store = getLifecycleStore();
  await store.applyTrendsIngest({
    result,
    source: `live:${args.equipment}`,
    equipment_id: args.equipment,
  });
  console.log(
    `[stream-worker] window flushed: ${samples.length} samples, ` +
      `${result.passes.length} pass(es), ${result.runs.length} run(s)`,
  );
}

async function main() {
  const args = parseCliArgs();
  const adapter = buildAdapter(args);
  const buffer = new WindowBuffer();

  const sub = await adapter.subscribe({
    equipmentId: args.equipment,
    onSample: (s) => {
      buffer.add(s);
      publishLiveSample(s); // fan out to any SSE subscribers
    },
    onError: (err) => console.error("[stream-worker] adapter error:", err.message),
  });

  const interval = setInterval(() => {
    void flushWindow(args, buffer).catch((err) =>
      console.error("[stream-worker] flush failed:", err),
    );
  }, args.windowSeconds * 1000);

  const shutdown = async () => {
    console.log("[stream-worker] shutting down...");
    clearInterval(interval);
    sub.stop();
    await adapter.disconnect();
    await flushWindow(args, buffer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    `[stream-worker] running adapter=${args.adapter} equipment=${args.equipment} ` +
      `window=${args.windowSeconds}s speed=${args.speed}x`,
  );
}

main().catch((err) => {
  console.error("[stream-worker] fatal:", err);
  process.exit(1);
});
