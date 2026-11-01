import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authRoutes } from "./routes/auth";
import { memoRoutes, shareRoutes } from "./routes/memos";
import { userRoutes, userActionRoutes } from "./routes/users";
import { attachmentRoutes, attachmentActionRoutes } from "./routes/attachments";
import { fileRoutes } from "./routes/files";
import { instanceRoutes } from "./routes/instance";
import { healthRoutes } from "./routes/health";
import { shortcutRoutes } from "./routes/shortcuts";
import { idpRoutes } from "./routes/idp";
import { aiRoutes } from "./routes/ai";
import { sseRoutes } from "./routes/sse";
import { exploreRssRoutes, rssRoutes } from "./routes/rss";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

const GRPC_STATUS_CODES: Record<number, number> = {
  400: 3,
  401: 16,
  403: 7,
  404: 5,
  405: 12,
  409: 6,
  429: 8,
  500: 13,
  501: 12,
  502: 13,
  503: 14,
  504: 14,
};

// Normalize legacy error payloads ({ error, errorKey }) into the official
// grpc-gateway error shape ({ code, message, details }).
app.use("/api/*", async (c, next) => {
  await next();

  if (c.res.status < 400) return;
  const contentType = c.res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return;

  let payload: Record<string, unknown>;
  try {
    payload = await c.res.clone().json();
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || "code" in payload) return;

  const message = typeof payload.error === "string"
    ? payload.error
    : typeof payload.message === "string"
      ? payload.message
      : "Request failed";
  const body: Record<string, unknown> = {
    code: GRPC_STATUS_CODES[c.res.status] ?? 13,
    message,
    details: [],
  };
  if (payload.errorKey) body.errorKey = payload.errorKey;
  if (payload.errorParams) body.errorParams = payload.errorParams;

  const headers = new Headers(c.res.headers);
  headers.set("content-type", "application/json; charset=UTF-8");
  c.res = new Response(JSON.stringify(body), { status: c.res.status, headers });
});

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1", userActionRoutes);
app.route("/api/v1", shareRoutes);
app.route("/api/v1", shortcutRoutes);
app.route("/api/v1", aiRoutes);
app.route("/api/v1", attachmentActionRoutes);
app.route("/api/v1/memos", memoRoutes);
app.route("/api/v1/users", userRoutes);
app.route("/api/v1/attachments", attachmentRoutes);
app.route("/api/v1/instance", instanceRoutes);
app.route("/api/v1/health", healthRoutes);
app.route("/api/v1/identity-providers", idpRoutes);
app.route("/api/v1/sse", sseRoutes);
app.route("/file", fileRoutes);
app.get("/u/:username", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/u/:username/", (c) => c.env.ASSETS.fetch(c.req.raw));
app.route("/u", rssRoutes);
app.route("/explore", exploreRssRoutes);

app.notFound((c) => {
  return c.json({ code: 5, message: "Not Found", details: [] }, 404);
});

app.onError((err, c) => {
  if (err.message?.includes("Method Not Allowed")) {
    return c.json({ code: 12, message: "Method Not Allowed", details: [] }, 405);
  }
  console.error(err);
  return c.json({ code: 2, message: err.message || "Internal Server Error", details: [] }, 500);
});

export default app;
