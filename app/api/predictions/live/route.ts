import { subscribeLive, recentLiveSamples, type LiveSample } from "@/lib/vantagepoint-adapter";

// Server-Sent Events endpoint for the live telemetry feed.
//
// The dashboard subscribes to /api/predictions/live and receives:
//
//   event: hello\ndata: {"buffered": <n>}\n\n   on connect
//   event: sample\ndata: { ts, signal, value, equipment_id }\n\n   per sample
//   event: ping\ndata: {}\n\n   ~every 20s to keep proxies from idling out
//
// The connection stays open until the client disconnects. SSE works through
// HTTP/2 + corporate proxies more reliably than WebSockets, and the stream
// worker (scripts/stream_worker.ts) publishes samples to the in-process bus
// that subscribeLive() reads from.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let pingInterval: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(sse(event, data)));
        } catch {
          // Controller has been closed — clean up.
          cleanup();
        }
      };

      // Replay the most recent in-memory samples so a fresh subscriber gets
      // immediate signal instead of a blank chart for the first window.
      const recent = recentLiveSamples();
      send("hello", {
        buffered: recent.length,
        started_at: new Date().toISOString(),
      });
      for (const s of recent) send("sample", s);

      unsubscribe = subscribeLive((s: LiveSample) => send("sample", s));
      pingInterval = setInterval(() => send("ping", {}), 20_000);

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Abort cleanly when the client disconnects.
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (pingInterval) clearInterval(pingInterval);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      // Disable Next.js / proxy buffering so events flush immediately.
      "x-accel-buffering": "no",
    },
  });
}
