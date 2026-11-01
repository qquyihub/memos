import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as userDB from "../db/user";
import * as settingDB from "../db/setting";
import * as memoDB from "../db/memo";
import * as webhookDB from "../db/webhook";
import { hashPassword } from "../auth/password";
import { generatePAT, hashPAT } from "../auth/pat";
import { exchangeOAuthCode } from "../auth/oauth";
import { createErrorBody } from "../error";
import { buildIdentityProviderName, extractIdentityProviderUid } from "../idp";
import { deleteCachedKeys, getCachedJson, putCachedJson } from "../cache";
import { getWebhookUrlValidationError, normalizeWebhookUrl } from "../webhook";

type UserApp = { Bindings: Env; Variables: { user: UserPayload } };

export const userRoutes = new Hono<UserApp>();

const getGeneralSetting = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "GENERAL");
  if (!setting) {
    return {};
  }
  try {
    return JSON.parse(setting.value) || {};
  } catch {
    return {};
  }
};

export function formatUser(user: userDB.UserRow, options: { includeEmail?: boolean } = {}) {
  return {
    name: `users/${user.username}`,
    role: user.role === "ADMIN" ? "ADMIN" : "USER",
    username: user.username,
    email: options.includeEmail ? user.email : "",
    displayName: user.nickname,
    avatarUrl: user.avatar_url,
    description: user.description,
    state: user.row_status === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    createTime: new Date(user.created_ts * 1000).toISOString(),
    updateTime: new Date(user.updated_ts * 1000).toISOString(),
  };
}

function formatPersonalAccessToken(username: string, token: {
  hash: string;
  description?: string;
  createdAt?: string;
  expiresAt?: string | null;
  lastUsedAt?: string;
}) {
  return {
    name: `users/${username}/personalAccessTokens/${token.hash}`,
    description: token.description || "",
    createdAt: token.createdAt || new Date().toISOString(),
    expiresAt: token.expiresAt || undefined,
    lastUsedAt: token.lastUsedAt || undefined,
    hash: token.hash,
  };
}

function normalizeUserSettingKey(key: string) {
  return String(key || "").toUpperCase();
}

function parseSettingObject(value?: string) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function findUserSettingRow(db: D1Database, userId: number, key: string) {
  for (const candidate of [key, key.toUpperCase(), key.toLowerCase()]) {
    const row = await settingDB.getUserSetting(db, userId, candidate);
    if (row) return row;
  }
  return null;
}

async function buildUserSettingEntity(db: D1Database, username: string, userId: number, key: string) {
  const normalizedKey = normalizeUserSettingKey(key);
  if (normalizedKey === "WEBHOOKS") {
    const webhooks = await webhookDB.listWebhooksByCreatorId(db, userId);
    return {
      name: `users/${username}/settings/WEBHOOKS`,
      webhooksSetting: { webhooks: webhooks.map((webhook) => formatWebhook(webhook, username)) },
    };
  }
  if (normalizedKey === "GENERAL") {
    const row = await findUserSettingRow(db, userId, "GENERAL");
    return {
      name: `users/${username}/settings/GENERAL`,
      generalSetting: parseSettingObject(row?.value),
    };
  }
  return { name: `users/${username}/settings/${key}` };
}

const USER_STATS_CACHE_SCOPES = ["public", "authenticated", "owner"] as const;

function getUserStatsCacheKeys(username: string) {
  return [
    `user:stats:${username}`,
    ...USER_STATS_CACHE_SCOPES.map((scope) => `user:stats:${username}:${scope}`),
  ];
}

function getUserStatsVisibilityScope(targetUserId: number, currentUser: UserPayload | undefined) {
  if (currentUser?.id === targetUserId) {
    return "owner";
  }
  return currentUser ? "authenticated" : "public";
}

function appendStatsVisibilityFilter(conditions: string[], targetUserId: number, currentUser: UserPayload | undefined) {
  const scope = getUserStatsVisibilityScope(targetUserId, currentUser);
  if (scope === "public") {
    conditions.push("visibility = 'PUBLIC'");
  } else if (scope === "authenticated") {
    conditions.push("visibility IN ('PUBLIC', 'PROTECTED')");
  }
  return scope;
}

// List users
userRoutes.get("/", authOptional, async (c) => {
  const currentUser = c.get("user");
  const includeEmail = currentUser?.role === "ADMIN";
  const users = await userDB.listUsers(c.env.DB, { rowStatus: "NORMAL" });
  return c.json({ users: users.map((user) => formatUser(user, { includeEmail })), nextPageToken: "", totalSize: users.length });
});

async function buildUserStats(
  c: { env: Env; get: (key: "user") => UserPayload | undefined },
  user: userDB.UserRow,
  currentUser: UserPayload | undefined,
) {
  const conditions = ["creator_id = ?", "row_status = 'NORMAL'"];
  const scope = appendStatsVisibilityFilter(conditions, user.id, currentUser);
  const cacheKey = `user:stats:${user.username}:${scope}`;
  const cached = scope === "owner" ? undefined : await getCachedJson(c.env.CACHE, cacheKey);
  if (cached) {
    return cached;
  }

  const { results: memos } = await c.env.DB.prepare(
    `SELECT uid, created_ts, updated_ts, payload, pinned FROM memo WHERE ${conditions.join(" AND ")}`
  ).bind(user.id).all<{ uid: string; created_ts: number; updated_ts: number; payload: string; pinned: number }>();

  const tagCounts: Record<string, number> = {};
  let linkCount = 0, codeCount = 0, todoCount = 0, undoCount = 0;
  const pinnedMemos: string[] = [];

  for (const m of memos) {
    const payload = JSON.parse(m.payload || "{}");
    if (payload.tags) {
      for (const tag of payload.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    if (payload.property?.hasLink) linkCount++;
    if (payload.property?.hasCode) codeCount++;
    if (payload.property?.hasTaskList) todoCount++;
    if (payload.property?.hasIncompleteTasks || payload.property?.hasIncompleteTask) undoCount++;
    if (m.pinned) pinnedMemos.push(`memos/${m.uid}`);
  }

  const response = {
    name: `users/${user.username}`,
    memoTypeStats: { linkCount, codeCount, todoCount, undoCount },
    tagCount: tagCounts,
    memoCreatedTimestamps: memos.map((m) => new Date(m.created_ts * 1000).toISOString()),
    memoUpdatedTimestamps: memos.map((m) => new Date(m.updated_ts * 1000).toISOString()),
    pinnedMemos,
    totalMemoCount: memos.length,
  };

  if (scope !== "owner") {
    await putCachedJson(c.env.CACHE, cacheKey, response, 60);
  }
  return response;
}

// Action routes mounted at /api/v1 (colon-style endpoints)
export const userActionRoutes = new Hono<UserApp>();

userActionRoutes.post("/users\\:batchGet", async (c) => {
  const body = await c.req.json<{ usernames: string[] }>();
  const users = (await userDB.findUsersByUsernames(c.env.DB, body.usernames || [])).filter((user) => user.row_status === "NORMAL");
  return c.json({ users: users.map((user) => formatUser(user)) });
});

userActionRoutes.get("/users\\:stats", authOptional, async (c) => {
  const cached = await getCachedJson(c.env.CACHE, "user:stats:all:public");
  if (cached) {
    return c.json(cached);
  }

  const users = await userDB.listUsers(c.env.DB, { rowStatus: "NORMAL" });
  const { results: memos } = await c.env.DB.prepare(
    "SELECT creator_id, payload FROM memo WHERE row_status = 'NORMAL' AND visibility = 'PUBLIC'"
  ).all<{ creator_id: number; payload: string }>();

  const memoStatsByUserId = new Map<number, {
    totalMemoCount: number;
    tagCount: Record<string, number>;
    linkCount: number;
    codeCount: number;
    todoCount: number;
    undoCount: number;
  }>();
  for (const memo of memos) {
    const stats = memoStatsByUserId.get(memo.creator_id) || {
      totalMemoCount: 0,
      tagCount: {},
      linkCount: 0,
      codeCount: 0,
      todoCount: 0,
      undoCount: 0,
    };
    stats.totalMemoCount += 1;
    const payload = JSON.parse(memo.payload || "{}");
    if (payload.tags) {
      for (const tag of payload.tags) {
        stats.tagCount[tag] = (stats.tagCount[tag] || 0) + 1;
      }
    }
    if (payload.property?.hasLink) stats.linkCount++;
    if (payload.property?.hasCode) stats.codeCount++;
    if (payload.property?.hasTaskList) stats.todoCount++;
    if (payload.property?.hasIncompleteTasks || payload.property?.hasIncompleteTask) stats.undoCount++;
    memoStatsByUserId.set(memo.creator_id, stats);
  }

  const stats = users.map((user) => {
    const memoStats = memoStatsByUserId.get(user.id) || {
      totalMemoCount: 0,
      tagCount: {},
      linkCount: 0,
      codeCount: 0,
      todoCount: 0,
      undoCount: 0,
    };
    return {
      name: `users/${user.username}`,
      memoTypeStats: {
        linkCount: memoStats.linkCount,
        codeCount: memoStats.codeCount,
        todoCount: memoStats.todoCount,
        undoCount: memoStats.undoCount,
      },
      tagCount: memoStats.tagCount,
      totalMemoCount: memoStats.totalMemoCount,
    };
  });
  const response = { stats };
  await putCachedJson(c.env.CACHE, "user:stats:all:public", response, 60);
  return c.json(response);
});

// Get user (or user stats when the path ends with ":getStats")
userRoutes.get("/:username", authOptional, async (c) => {
  let username = c.req.param("username");
  const currentUser = c.get("user");

  if (username.endsWith(":getStats")) {
    username = username.slice(0, -":getStats".length);
    const user = await userDB.findUserByUsername(c.env.DB, username);
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json(await buildUserStats(c, user, currentUser));
  }

  let user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user && /^\d+$/.test(username)) {
    user = await c.env.DB.prepare("SELECT * FROM user WHERE id = ?").bind(Number(username)).first<userDB.UserRow>();
  }
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.row_status !== "NORMAL" && currentUser?.id !== user.id && currentUser?.role !== "ADMIN") {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json(formatUser(user, { includeEmail: currentUser?.id === user.id || currentUser?.role === "ADMIN" }));
});

// Create user (admin, or self-registration when allowed)
userRoutes.post("/", async (c) => {
  const userCount = await userDB.countUsers(c.env.DB);

  // First user is always allowed (becomes admin)
  if (userCount === 0) {
    const body = await c.req.json();
    const userData = body.user || body;
    const username = userData.username;
    const password = userData.password;

    if (!username || !password) {
      return c.json({ error: "Username and password required" }, 400);
    }

    const passwordHash = await hashPassword(password);
    const user = await userDB.createUser(c.env.DB, { username, passwordHash, role: "ADMIN" });
    await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", "user:stats:all:public"]);
    return c.json(formatUser(user, { includeEmail: true }));
  }

  // Check if self-registration is allowed
  const generalSetting = await getGeneralSetting(c.env.DB);
  const disallowRegistration = generalSetting.disallowUserRegistration === true;
  const disallowPasswordAuth = generalSetting.disallowPasswordAuth === true;

  // Check auth header
  const authHeader = c.req.header("Authorization");
  let isAdmin = false;

  if (authHeader?.startsWith("Bearer ")) {
    const { verifyAccessToken } = await import("../auth/jwt");
    try {
      const claims = await verifyAccessToken(authHeader.slice(7), c.env.JWT_SECRET);
      isAdmin = claims.role === "ADMIN";
    } catch {}
  }

  // Admin can always create users; non-admin can self-register if allowed
  if (!isAdmin && (disallowRegistration || disallowPasswordAuth)) {
    return c.json(createErrorBody("User registration is disabled", { errorKey: "message.user-registration-disabled" }), 403);
  }

  const body = await c.req.json();
  const userData = body.user || body;
  const username = userData.username;
  const password = userData.password;

  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const existing = await userDB.findUserByUsername(c.env.DB, username);
  if (existing) return c.json({ error: "Username taken" }, 409);

  // Only admin can create admin users
  const wantsAdmin = userData.role === 2 || String(userData.role || "").toUpperCase() === "ADMIN";
  const role = isAdmin && wantsAdmin ? "ADMIN" : "USER";
  const passwordHash = await hashPassword(password);
  const user = await userDB.createUser(c.env.DB, { username, passwordHash, role });
  await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", "user:stats:all:public"]);

  return c.json(formatUser(user, { includeEmail: true }));
});

// Update user
userRoutes.patch("/:username", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json();
  const updateData: Parameters<typeof userDB.updateUser>[2] = {};

  const generalSetting = await getGeneralSetting(c.env.DB);

  if (body.nickname !== undefined || body.displayName !== undefined) {
    if (user.id === currentUser.id && currentUser.role !== "ADMIN" && generalSetting.disallowChangeNickname === true) {
      return c.json(createErrorBody("Changing nickname is disabled", { errorKey: "message.nickname-change-disabled" }), 403);
    }
    updateData.nickname = body.nickname ?? body.displayName;
  }
  if (body.email !== undefined) updateData.email = body.email;
  if (body.avatarUrl !== undefined) updateData.avatar_url = body.avatarUrl;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.password) updateData.password_hash = await hashPassword(body.password);
  if ((body.role !== undefined || body.state !== undefined) && currentUser.role === "ADMIN") {
    if (body.role !== undefined) {
      const roleValue = typeof body.role === "number" ? (body.role === 2 ? "ADMIN" : "USER") : String(body.role).toUpperCase();
      updateData.role = roleValue === "ADMIN" ? "ADMIN" : "USER";
    }
    if (body.state !== undefined) updateData.row_status = body.state;
  }
  if (body.rowStatus !== undefined) updateData.row_status = body.rowStatus;
  if (body.username !== undefined) {
    if (currentUser.role === "ADMIN") {
      updateData.username = body.username;
    } else if (user.id === currentUser.id) {
      if (generalSetting.disallowChangeUsername === true) {
        return c.json(createErrorBody("Changing username is disabled", { errorKey: "message.username-change-disabled" }), 403);
      }
      if (body.username !== user.username) {
        return c.json(createErrorBody("Changing username requires admin privileges", { errorKey: "message.username-change-admin-only" }), 403);
      }
    }
  }

  const updated = await userDB.updateUser(c.env.DB, user.id, updateData);
  if (!updated) return c.json({ error: "Update failed" }, 500);
  await deleteCachedKeys(c.env.CACHE, [
    "instance:profile",
    "user:stats:all",
    "user:stats:all:public",
    ...getUserStatsCacheKeys(user.username),
    ...getUserStatsCacheKeys(updated.username),
  ]);

  return c.json(formatUser(updated, { includeEmail: true }));
});

// Delete user
userRoutes.delete("/:username", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);

  await userDB.deleteUser(c.env.DB, user.id);
  await deleteCachedKeys(c.env.CACHE, ["instance:profile", "user:stats:all", "user:stats:all:public", ...getUserStatsCacheKeys(user.username)]);
  return c.json({});
});

// --- User Settings ---
userRoutes.get("/:username/settings", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const settings = await Promise.all([
    buildUserSettingEntity(c.env.DB, username, user.id, "GENERAL"),
    buildUserSettingEntity(c.env.DB, username, user.id, "WEBHOOKS"),
  ]);
  return c.json({ settings, nextPageToken: "", totalSize: settings.length });
});

userRoutes.get("/:username/settings/:key", authRequired, async (c) => {
  const username = c.req.param("username");
  const key = c.req.param("key");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  return c.json(await buildUserSettingEntity(c.env.DB, username, user.id, key));
});

userRoutes.patch("/:username/settings/:key", authRequired, async (c) => {
  const username = c.req.param("username");
  const key = c.req.param("key");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const normalizedKey = normalizeUserSettingKey(key);
  if (normalizedKey === "WEBHOOKS") {
    return c.json(await buildUserSettingEntity(c.env.DB, username, user.id, "WEBHOOKS"));
  }

  const body = await c.req.json<Record<string, any>>();
  const settingInput = body.setting ?? body;
  let newValue = settingInput.generalSetting ?? settingInput.value ?? {};
  if (typeof newValue === "string") {
    try {
      newValue = JSON.parse(newValue);
    } catch {
      newValue = {};
    }
  }
  if (typeof newValue !== "object" || newValue === null) {
    newValue = {};
  }

  // Merge with existing setting value
  const existing = await findUserSettingRow(c.env.DB, user.id, key);
  let merged = newValue;
  if (existing) {
    try {
      const existingValue = JSON.parse(existing.value);
      merged = { ...existingValue, ...newValue };
    } catch {
      merged = newValue;
    }
  }

  await settingDB.setUserSetting(c.env.DB, user.id, normalizedKey === "GENERAL" ? "GENERAL" : key, JSON.stringify(merged));
  return c.json(await buildUserSettingEntity(c.env.DB, username, user.id, key));
});

// --- Personal Access Tokens ---
userRoutes.get("/:username/personalAccessTokens", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  const tokens = setting ? JSON.parse(setting.value) : [];
  return c.json({
    personalAccessTokens: tokens.map((token: {
      hash: string;
      description?: string;
      createdAt?: string;
      expiresAt?: string | null;
      lastUsedAt?: string;
    }) => formatPersonalAccessToken(username, token)),
    nextPageToken: "",
    totalSize: tokens.length,
  });
});

userRoutes.post("/:username/personalAccessTokens", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  let body: { description?: string; expiresAt?: string; expiresInDays?: number } = {};
  try { body = await c.req.json(); } catch {}
  const token = generatePAT();
  const hash = await hashPAT(token);

  let expiresAt = body.expiresAt || null;
  if (!expiresAt && body.expiresInDays && body.expiresInDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() + body.expiresInDays);
    expiresAt = d.toISOString();
  }

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  const tokens = setting ? JSON.parse(setting.value) : [];
  const tokenRecord = {
    hash,
    description: body.description || "",
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  tokens.push(tokenRecord);

  await settingDB.setUserSetting(c.env.DB, user.id, "personal_access_tokens", JSON.stringify(tokens));

  return c.json({
    personalAccessToken: formatPersonalAccessToken(username, tokenRecord),
    token,
  });
});

userRoutes.delete("/:username/personalAccessTokens/:tokenHash", authRequired, async (c) => {
  const username = c.req.param("username");
  const tokenHash = c.req.param("tokenHash");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id) return c.json({ error: "Permission denied" }, 403);

  const setting = await settingDB.getUserSetting(c.env.DB, user.id, "personal_access_tokens");
  if (setting) {
    const tokens = JSON.parse(setting.value).filter((t: { hash: string }) => t.hash !== tokenHash);
    await settingDB.setUserSetting(c.env.DB, user.id, "personal_access_tokens", JSON.stringify(tokens));
  }

  return c.json({});
});

// --- Linked Identities ---
userRoutes.get("/:username/linkedIdentities", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM user_identity WHERE user_id = ?"
  ).bind(user.id).all<{ id: number; user_id: number; provider: string; extern_uid: string }>();

  const linkedIdentities = (results || []).map((row) => ({
    name: `users/${username}/linkedIdentities/${row.id}`,
    idpName: buildIdentityProviderName(row.provider),
    externUid: row.extern_uid,
  }));

  return c.json({ linkedIdentities });
});

userRoutes.post("/:username/linkedIdentities", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ idpName?: string; code?: string; redirectUri?: string; codeVerifier?: string }>();
  const idpUid = extractIdentityProviderUid(body.idpName);
  if (!idpUid || !body.code) {
    return c.json({ error: "Missing IDP name or authorization code" }, 400);
  }

  let oauthUser;
  try {
    oauthUser = await exchangeOAuthCode(c.env.DB, idpUid, body.code, body.redirectUri || "", body.codeVerifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to link identity provider";
    console.error("Failed to exchange OAuth code for linked identity:", error);
    const status =
      message.includes("already linked")
        ? 409
        : message.includes("Identity provider not found") ||
            message.includes("configuration is incomplete") ||
            message.includes("Token exchange failed") ||
            message.includes("OAuth error:") ||
            message.includes("No access_token") ||
            message.includes("User info request failed") ||
            message.includes("Could not extract user identifier") ||
            message.includes("does not match the allowed pattern")
          ? 400
          : 500;
    return c.json(createErrorBody(message), status);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM user_identity WHERE provider = ? AND extern_uid = ?"
  ).bind(idpUid, oauthUser.identifier).first<{ id: number }>();
  if (existing) {
    return c.json({ error: "This identity is already linked to another account" }, 409);
  }

  const result = await c.env.DB.prepare(
    "INSERT INTO user_identity (user_id, provider, extern_uid) VALUES (?, ?, ?) RETURNING *"
  ).bind(user.id, idpUid, oauthUser.identifier).first<{ id: number; provider: string; extern_uid: string }>();

  return c.json({
    name: `users/${username}/linkedIdentities/${result!.id}`,
    idpName: buildIdentityProviderName(result!.provider),
    externUid: result!.extern_uid,
  });
});

userRoutes.delete("/:username/linkedIdentities/:identityId", authRequired, async (c) => {
  const username = c.req.param("username");
  const identityId = c.req.param("identityId");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM user_identity WHERE id = ? AND user_id = ?")
    .bind(identityId, user.id).run();

  return c.json({});
});

// --- User Notifications ---
function formatUserNotification(
  username: string,
  row: { id: number; created_ts: number; sender_id: number; status: string; message: string },
  sender?: userDB.UserRow,
) {
  const msg = JSON.parse(row.message || "{}");
  const type = msg.type === "MEMO_MENTION"
    ? "MEMO_MENTION"
    : msg.type === "MEMO_COMMENT"
      ? "MEMO_COMMENT"
      : "TYPE_UNSPECIFIED";

  const notification: Record<string, any> = {
    name: `users/${username}/notifications/${row.id}`,
    sender: sender ? `users/${sender.username}` : "",
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "UNREAD",
    createTime: new Date(row.created_ts * 1000).toISOString(),
    type,
  };
  if (sender) {
    notification.senderUser = formatUser(sender);
  }

  const payload = {
    memo: msg.memo || "",
    relatedMemo: msg.relatedMemo || "",
    memoSnippet: msg.memoSnippet || "",
    relatedMemoSnippet: msg.relatedMemoSnippet || "",
  };
  if (type === "MEMO_COMMENT") {
    notification.memoComment = payload;
  } else if (type === "MEMO_MENTION") {
    notification.memoMention = payload;
  }

  return notification;
}

userRoutes.get("/:username/notifications", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM inbox WHERE receiver_id = ? ORDER BY created_ts DESC"
  ).bind(user.id).all<{ id: number; created_ts: number; sender_id: number; receiver_id: number; status: string; message: string }>();

  const senderIds = [...new Set((results || []).map((r) => r.sender_id))];
  const senderMap = new Map<number, userDB.UserRow>();
  const senders = await userDB.findUsersByIds(c.env.DB, senderIds);
  for (const sender of senders) {
    senderMap.set(sender.id, sender);
  }

  const notifications = (results || []).map((row) =>
    formatUserNotification(username, row, senderMap.get(row.sender_id))
  );

  return c.json({ notifications, nextPageToken: "" });
});

userRoutes.patch("/:username/notifications/:notifId", authRequired, async (c) => {
  const username = c.req.param("username");
  const notifId = Number(c.req.param("notifId"));
  const currentUser = c.get("user");
  if (username !== currentUser.username && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<Record<string, any>>();
  const notificationInput = body.notification ?? body;
  const statusMap: Record<number, string> = { 1: "UNREAD", 2: "ARCHIVED" };
  const status = typeof notificationInput.status === "number"
    ? (statusMap[notificationInput.status] || "UNREAD")
    : notificationInput.status;

  await c.env.DB.prepare("UPDATE inbox SET status = ? WHERE id = ? AND receiver_id = ?")
    .bind(status, notifId, currentUser.id).run();

  const row = await c.env.DB.prepare(
    "SELECT * FROM inbox WHERE id = ? AND receiver_id = ?"
  ).bind(notifId, currentUser.id).first<{ id: number; created_ts: number; sender_id: number; receiver_id: number; status: string; message: string }>();
  if (!row) return c.json({ error: "Notification not found" }, 404);

  const [sender] = await userDB.findUsersByIds(c.env.DB, [row.sender_id]);
  return c.json(formatUserNotification(username, row, sender));
});

userRoutes.delete("/:username/notifications/:notifId", authRequired, async (c) => {
  const notifId = Number(c.req.param("notifId"));
  const currentUser = c.get("user");

  await c.env.DB.prepare("DELETE FROM inbox WHERE id = ? AND receiver_id = ?")
    .bind(notifId, currentUser.id).run();

  return c.json({});
});

// --- Webhooks ---
function formatWebhook(webhook: webhookDB.WebhookRow, username: string) {
  return {
    name: `users/${username}/webhooks/${webhook.id}`,
    url: webhook.url,
    displayName: webhook.display_name,
    createTime: new Date(webhook.created_ts * 1000).toISOString(),
    updateTime: new Date(webhook.updated_ts * 1000).toISOString(),
  };
}

userRoutes.get("/:username/webhooks", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const webhooks = await webhookDB.listWebhooksByCreatorId(c.env.DB, user.id);
  return c.json({ webhooks: webhooks.map((w) => formatWebhook(w, username)) });
});

userRoutes.post("/:username/webhooks", authRequired, async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ url?: string; displayName?: string }>();
  const urlError = getWebhookUrlValidationError(body.url);
  if (urlError) return c.json({ error: urlError }, 400);

  const webhook = await webhookDB.createWebhook(c.env.DB, {
    creatorId: user.id,
    url: normalizeWebhookUrl(body.url)!,
    displayName: body.displayName?.trim() || "",
  });
  return c.json(formatWebhook(webhook, username));
});

userRoutes.patch("/:username/webhooks/:webhookId", authRequired, async (c) => {
  const username = c.req.param("username");
  const webhookId = Number(c.req.param("webhookId"));
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const existing = await webhookDB.getWebhookById(c.env.DB, webhookId);
  if (!existing || existing.creator_id !== user.id) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  const body = await c.req.json<{ url?: string; displayName?: string }>();
  const updateData: Partial<{ url: string; display_name: string }> = {};
  if (body.url !== undefined) {
    const urlError = getWebhookUrlValidationError(body.url);
    if (urlError) return c.json({ error: urlError }, 400);
    updateData.url = normalizeWebhookUrl(body.url)!;
  }
  if (body.displayName !== undefined) updateData.display_name = body.displayName.trim();

  const updated = await webhookDB.updateWebhook(c.env.DB, webhookId, updateData);
  if (!updated) return c.json({ error: "Update failed" }, 500);
  return c.json(formatWebhook(updated, username));
});

userRoutes.delete("/:username/webhooks/:webhookId", authRequired, async (c) => {
  const username = c.req.param("username");
  const webhookId = Number(c.req.param("webhookId"));
  const currentUser = c.get("user");
  const user = await userDB.findUserByUsername(c.env.DB, username);
  if (!user) return c.json({ error: "User not found" }, 404);
  if (user.id !== currentUser.id && currentUser.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const existing = await webhookDB.getWebhookById(c.env.DB, webhookId);
  if (!existing || existing.creator_id !== user.id) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  await webhookDB.deleteWebhook(c.env.DB, webhookId);
  return c.json({});
});
