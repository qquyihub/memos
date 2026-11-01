import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authOptional, authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import * as userDB from "../db/user";
import { getAppVersion } from "../version";
import { deleteCachedKeys, getCachedJson, putCachedJson } from "../cache";
import { getUploadPolicy } from "../storage";
import { formatUser } from "./users";

type InstApp = { Bindings: Env; Variables: { user: UserPayload } };

export const instanceRoutes = new Hono<InstApp>();

const PUBLIC_INSTANCE_SETTING_KEYS = new Set(["GENERAL", "MEMO_RELATED", "TAGS", "AI"]);

function getInstanceSettingKey(name: string): string {
  return settingDB.normalizeInstanceSettingName(name).split("/").pop() || "";
}

const INSTANCE_SETTING_VALUE_FIELDS: Record<string, string> = {
  GENERAL: "generalSetting",
  STORAGE: "storageSetting",
  MEMO_RELATED: "memoRelatedSetting",
  TAGS: "tagsSetting",
  NOTIFICATION: "notificationSetting",
  AI: "aiSetting",
};

function parseInstanceSettingObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function formatInstanceSetting(name: string, rawValue: string) {
  const field = INSTANCE_SETTING_VALUE_FIELDS[getInstanceSettingKey(name)];
  return {
    name,
    ...(field ? { [field]: parseInstanceSettingObject(rawValue) } : {}),
  };
}

function sanitizePublicInstanceSettingValue(name: string, value: string): string {
  const key = getInstanceSettingKey(name);
  if (key !== "AI") {
    return value;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return "{}";
    }

    const next = {
      ...parsed,
      providers: Array.isArray((parsed as { providers?: unknown[] }).providers)
        ? (parsed as { providers: Array<{ apiKeySet?: boolean; apiKeyHint?: string; [key: string]: unknown }> }).providers.map((provider) => ({
            ...provider,
            apiKey: "",
            apiKeySet: Boolean(provider.apiKeySet || provider.apiKey),
            apiKeyHint: provider.apiKeyHint || (provider.apiKeySet || provider.apiKey ? "configured" : ""),
          }))
        : [],
    };

    return JSON.stringify(next);
  } catch {
    return "{}";
  }
}

// Get instance profile
instanceRoutes.get("/profile", async (c) => {
  const cached = await getCachedJson(c.env.CACHE, "instance:profile");
  if (cached) {
    return c.json(cached);
  }

  const userCount = await userDB.countUsers(c.env.DB);
  const instanceUrl = new URL(c.req.url).origin;

  let admin = undefined;
  if (userCount > 0) {
    const adminUser = await c.env.DB.prepare(
      "SELECT * FROM user WHERE role = 'ADMIN' ORDER BY created_ts ASC LIMIT 1"
    ).first<userDB.UserRow>();
    if (adminUser) {
      admin = formatUser(adminUser, { includeEmail: true });
    }
  }

  const response = {
    version: getAppVersion(c.env),
    demo: false,
    instanceUrl,
    ...(admin ? { admin } : {}),
    commit: "",
  };

  await putCachedJson(c.env.CACHE, "instance:profile", response, 600);
  return c.json(response);
});

// Get the non-sensitive upload policy (naming template and image preprocessing)
instanceRoutes.get("/upload-config", async (c) => {
  const cached = await getCachedJson(c.env.CACHE, "instance:upload-config");
  if (cached) {
    return c.json(cached);
  }

  const policy = await getUploadPolicy(c.env.DB);
  await putCachedJson(c.env.CACHE, "instance:upload-config", policy, 300);
  return c.json(policy);
});

// Batch get instance settings
instanceRoutes.post("/settings\\:batchGet", authOptional, async (c) => {
  const currentUser = c.get("user");
  const isAdmin = currentUser?.role === "ADMIN";
  const body = await c.req.json<{ names?: string[] }>();
  const settings = [];

  for (const rawName of body.names || []) {
    const name = settingDB.normalizeInstanceSettingName(rawName);
    const key = getInstanceSettingKey(name);
    if (!PUBLIC_INSTANCE_SETTING_KEYS.has(key) && !isAdmin) {
      continue;
    }
    const setting = await settingDB.getInstanceSetting(c.env.DB, name);
    const rawValue = setting?.value ?? "{}";
    const value = PUBLIC_INSTANCE_SETTING_KEYS.has(key) && !isAdmin
      ? sanitizePublicInstanceSettingValue(key, rawValue)
      : rawValue;
    settings.push(formatInstanceSetting(name, value));
  }

  return c.json({ settings });
});

// Get instance setting
instanceRoutes.get("/settings/*", authOptional, async (c) => {
  const fullPath = c.req.path;
  const name = settingDB.normalizeInstanceSettingName(fullPath.replace("/api/v1/instance/settings/", ""));
  const key = getInstanceSettingKey(name);
  const currentUser = c.get("user");
  const isAdmin = currentUser?.role === "ADMIN";
  if (!PUBLIC_INSTANCE_SETTING_KEYS.has(key) && !isAdmin) {
    return c.json({ error: "Admin only" }, 403);
  }

  const cacheKey = key === "AI" ? `instance:setting:${name}:${isAdmin ? "admin" : "public"}` : `instance:setting:${name}`;
  const cached = await getCachedJson(c.env.CACHE, cacheKey);
  if (cached) {
    return c.json(cached);
  }

  const setting = await settingDB.getInstanceSetting(c.env.DB, name);
  const rawValue = setting?.value ?? "{}";
  const value = PUBLIC_INSTANCE_SETTING_KEYS.has(key) && !isAdmin
    ? sanitizePublicInstanceSettingValue(key, rawValue)
    : rawValue;
  const response = formatInstanceSetting(name, value);
  await putCachedJson(c.env.CACHE, cacheKey, response, 300);
  return c.json(response);
});

// Test email setting via Resend (admin only)
instanceRoutes.post("/settings/notification\\:testEmail", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json<{ email?: { apiKey?: string; fromEmail?: string; fromName?: string }; recipientEmail?: string }>();

  let apiKey = body.email?.apiKey;
  let fromEmail = body.email?.fromEmail;
  let fromName = body.email?.fromName;

  if (!apiKey || !fromEmail) {
    const setting = await settingDB.getInstanceSetting(c.env.DB, "NOTIFICATION");
    if (setting) {
      const parsed = JSON.parse(setting.value);
      const email = parsed.email || {};
      if (!apiKey) apiKey = email.apiKey;
      if (!fromEmail) fromEmail = email.fromEmail;
      if (!fromName) fromName = email.fromName;
    }
  }

  if (!apiKey || !fromEmail) {
    return c.json({ error: "Resend API key and from email are required" }, 400);
  }

  const recipientEmail = body.recipientEmail;
  if (!recipientEmail) {
    return c.json({ error: "Recipient email is required" }, 400);
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [recipientEmail],
      subject: "Test email from Memos",
      html: "<p>This is a test email sent from your Memos instance to verify the email configuration.</p>",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return c.json({ error: `Resend API error: ${err}` }, 502);
  }

  return c.json({});
});

// Update instance setting (admin only)
instanceRoutes.patch("/settings/*", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const fullPath = c.req.path;
  const name = settingDB.normalizeInstanceSettingName(fullPath.replace("/api/v1/instance/settings/", ""));
  const key = getInstanceSettingKey(name);
  const body = await c.req.json<Record<string, any>>();
  const settingInput = body.setting ?? body;
  const field = INSTANCE_SETTING_VALUE_FIELDS[key];
  const innerValue = (field && settingInput[field] !== undefined)
    ? settingInput[field]
    : (settingInput.value ?? {});
  const valueStr = typeof innerValue === "string" ? innerValue : JSON.stringify(innerValue);

  await settingDB.setSystemSetting(c.env.DB, name, valueStr, settingInput.description);
  const settingCacheKeys =
    key === "AI"
      ? [`instance:setting:${name}:admin`, `instance:setting:${name}:public`]
      : [`instance:setting:${name}`];
  await deleteCachedKeys(c.env.CACHE, [
    "instance:profile",
    ...settingCacheKeys,
    ...(key === "STORAGE" ? ["instance:upload-config"] : []),
  ]);
  return c.json(formatInstanceSetting(name, valueStr));
});

instanceRoutes.get("/stats", authRequired, async (c) => {
  const currentUser = c.get("user");
  if (currentUser.role !== "ADMIN") {
    return c.json({ error: "Admin only" }, 403);
  }

  const cached = await getCachedJson(c.env.CACHE, "instance:stats");
  if (cached) {
    return c.json(cached);
  }

  const storageRow = await c.env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM attachment").first<{ total: number }>();
  const localStorageBytes = storageRow?.total ?? 0;

  let databaseSize = -1;
  try {
    const pageCountRow = await c.env.DB.prepare("PRAGMA page_count").first<{ page_count?: number; pageCount?: number }>();
    const pageSizeRow = await c.env.DB.prepare("PRAGMA page_size").first<{ page_size?: number; pageSize?: number }>();
    const pageCount = pageCountRow?.page_count ?? pageCountRow?.pageCount ?? 0;
    const pragmaPageSize = pageSizeRow?.page_size ?? pageSizeRow?.pageSize ?? 0;
    if (pageCount > 0 && pragmaPageSize > 0) {
      databaseSize = pageCount * pragmaPageSize;
    }
  } catch {
    databaseSize = -1;
  }

  const response = {
    database: {
      driver: "sqlite",
      sizeBytes: String(databaseSize),
    },
    localStorageBytes: String(localStorageBytes),
    generatedTime: new Date().toISOString(),
  };

  await putCachedJson(c.env.CACHE, "instance:stats", response, 60);
  return c.json(response);
});
