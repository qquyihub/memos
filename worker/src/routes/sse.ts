import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import { canReceiveMemoEvent, getLatestMemoEventId, listMemoEventsAfter } from "../events";

type SSEApp = { Bindings: Env; Variables: { user: UserPayload } };

export const sseRoutes = new Hono<SSEApp>();

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 30000;

sseRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const encoder = new TextEncoder();
  let lastEventId = await getLatestMemoEventId(db);
  let closed = false;
  let heartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const abortHandler = () => {
        closed = true;
      };
      c.req.raw.signal.addEventListener("abort", abortHandler);

      enqueue(": connected\n\n");

      while (!closed) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (closed) break;

        if (c.req.raw.signal.aborted) {
          closed = true;
          break;
        }

        try {
          const events = await listMemoEventsAfter(db, lastEventId);
          for (const event of events) {
            lastEventId = Math.max(lastEventId, event.id);
            if (!canReceiveMemoEvent(event, user.id, user.role)) {
              continue;
            }
            const payload = {
              type: event.type,
              name: event.name,
              ...(event.parent ? { parent: event.parent } : {}),
            };
            enqueue(`id: ${event.id}\ndata: ${JSON.stringify(payload)}\n\n`);
          }
        } catch (error) {
          console.warn("Failed to read memo events for SSE", error);
        }

        if (Date.now() >= heartbeatAt) {
          enqueue(": heartbeat\n\n");
          heartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
        }
      }

      try {
        controller.close();
      } catch {
        // Client is already gone.
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
