import { Hono } from "hono";
import {
  buildIdentityProviderName,
  extractIdentityProviderUid,
  normalizeIdentityProviderType,
  normalizeStoredOAuth2Config,
  serializeIdentityProvider,
  type IdpRow,
} from "../idp";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";

type IdpApp = { Bindings: Env; Variables: { user: UserPayload } };

export const idpRoutes = new Hono<IdpApp>();

idpRoutes.get("/", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM idp ORDER BY id ASC").all<IdpRow>();
  return c.json({ identityProviders: (results || []).map((row) => serializeIdentityProvider(row)) });
});

idpRoutes.get("/:id", async (c) => {
  const id = extractIdentityProviderUid(c.req.param("id"));
  const result = await c.env.DB.prepare("SELECT * FROM idp WHERE id = ? OR uid = ?").bind(id, id).first<IdpRow>();
  if (!result) {
    return c.json({ error: "Identity provider not found" }, 404);
  }
  return c.json(serializeIdentityProvider(result));
});

idpRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const body = await c.req.json<Record<string, any>>();
  const identityProvider = body.identityProvider ?? body;
  const requestedId = extractIdentityProviderUid(
    c.req.query("identityProviderId") || c.req.query("identity_provider_id") || identityProvider.name,
  );
  const uid = requestedId || crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const title = typeof identityProvider.title === "string" && identityProvider.title.trim()
    ? identityProvider.title.trim()
    : uid;
  const type = normalizeIdentityProviderType(identityProvider.type);
  const identifierFilter = identityProvider.identifierFilter || identityProvider.identifier_filter || "";
  const config = normalizeStoredOAuth2Config(identityProvider.config);
  const result = await c.env.DB.prepare(
    "INSERT INTO idp (uid, name, type, identifier_filter, config) VALUES (?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(uid, title, type, identifierFilter, JSON.stringify(config))
    .first<IdpRow>();

  return c.json(
    serializeIdentityProvider(
      result || {
        uid,
        name: title,
        type,
        identifier_filter: identifierFilter,
        config: JSON.stringify(config),
      },
    ),
  );
});

idpRoutes.patch("/:id", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const id = extractIdentityProviderUid(c.req.param("id"));
  const body = await c.req.json<Record<string, any>>();
  const identityProvider = body.identityProvider ?? body;
  const updates: string[] = [];
  const params: unknown[] = [];

  const title =
    typeof identityProvider.title === "string"
      ? identityProvider.title.trim()
      : typeof identityProvider.name === "string" && !identityProvider.name.startsWith(buildIdentityProviderName(""))
        ? identityProvider.name.trim()
        : undefined;
  if (title !== undefined) {
    updates.push("name = ?");
    params.push(title);
  }
  if (identityProvider.type !== undefined) {
    updates.push("type = ?");
    params.push(normalizeIdentityProviderType(identityProvider.type));
  }
  if (identityProvider.identifierFilter !== undefined || identityProvider.identifier_filter !== undefined) {
    updates.push("identifier_filter = ?");
    params.push(identityProvider.identifierFilter ?? identityProvider.identifier_filter ?? "");
  }
  if (identityProvider.config !== undefined) {
    const existing = await c.env.DB.prepare("SELECT * FROM idp WHERE id = ? OR uid = ?").bind(id, id).first<IdpRow>();
    const nextConfig = normalizeStoredOAuth2Config(identityProvider.config);
    if (nextConfig.clientSecret === "" && existing) {
      const existingConfig = normalizeStoredOAuth2Config(existing.config);
      nextConfig.clientSecret = existingConfig.clientSecret;
    }
    updates.push("config = ?");
    params.push(JSON.stringify(nextConfig));
  }

  if (updates.length > 0) {
    params.push(id);
    await c.env.DB.prepare(`UPDATE idp SET ${updates.join(", ")} WHERE id = ? OR uid = ?`).bind(...params, id).run();
  }

  const result = await c.env.DB.prepare("SELECT * FROM idp WHERE id = ? OR uid = ?").bind(id, id).first<IdpRow>();
  if (!result) {
    return c.json({ error: "Identity provider not found" }, 404);
  }
  return c.json(serializeIdentityProvider(result));
});

idpRoutes.delete("/:id", authRequired, async (c) => {
  const user = c.get("user");
  if (user.role !== "ADMIN") return c.json({ error: "Admin only" }, 403);

  const id = extractIdentityProviderUid(c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM idp WHERE id = ? OR uid = ?").bind(id, id).run();
  return c.json({});
});
