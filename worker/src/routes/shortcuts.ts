import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";
import * as userDB from "../db/user";
import { buildMemoFilterWhere, MemoFilterError } from "../filter/memo-filter";

type ShortcutApp = { Bindings: Env; Variables: { user: UserPayload } };

export const shortcutRoutes = new Hono<ShortcutApp>();

interface ShortcutRecord {
  id: string;
  name: string;
  title: string;
  filter: string;
}

type ShortcutOwner = { id: number; username: string };

function createShortcutId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function getShortcutIdFromName(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const parts = name.split("/");
  const index = parts.lastIndexOf("shortcuts");
  return index >= 0 ? parts[index + 1] || undefined : undefined;
}

function buildShortcutName(username: string, id: string): string {
  return `users/${username}/shortcuts/${id}`;
}

function formatShortcut(shortcut: ShortcutRecord) {
  return {
    name: shortcut.name,
    title: shortcut.title,
    filter: shortcut.filter,
  };
}

function normalizeShortcut(value: unknown, owner: ShortcutOwner): ShortcutRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const id = getShortcutIdFromName(raw.name) || (typeof raw.id === "string" ? raw.id : undefined);
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: buildShortcutName(owner.username, id),
    title: typeof raw.title === "string" ? raw.title : "",
    filter: typeof raw.filter === "string" ? raw.filter : "",
  };
}

async function loadShortcuts(db: D1Database, owner: ShortcutOwner): Promise<ShortcutRecord[]> {
  const setting = await settingDB.getUserSetting(db, owner.id, "shortcuts");
  if (!setting) {
    return [];
  }

  try {
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      const shortcut = normalizeShortcut(item, owner);
      return shortcut ? [shortcut] : [];
    });
  } catch {
    return [];
  }
}

async function saveShortcuts(db: D1Database, owner: ShortcutOwner, shortcuts: ShortcutRecord[]) {
  await settingDB.setUserSetting(
    db,
    owner.id,
    "shortcuts",
    JSON.stringify(
      shortcuts.map((shortcut) => ({
        id: shortcut.id,
        name: buildShortcutName(owner.username, shortcut.id),
        title: shortcut.title,
        filter: shortcut.filter,
      })),
    ),
  );
}

async function validateShortcutFilter(db: D1Database, filter: string): Promise<string | undefined> {
  try {
    await buildMemoFilterWhere(db, filter);
    return undefined;
  } catch (error) {
    return error instanceof MemoFilterError ? error.message : "Invalid shortcut filter";
  }
}

async function resolveOwner(
  db: D1Database,
  currentUser: UserPayload,
  username: string,
): Promise<{ owner?: ShortcutOwner; error?: { message: string; status: 403 | 404 } }> {
  if (currentUser.username !== username && currentUser.role !== "ADMIN") {
    return { error: { message: "Permission denied", status: 403 } };
  }
  const owner = await userDB.findUserByUsername(db, username);
  if (!owner) {
    return { error: { message: "User not found", status: 404 } };
  }
  return { owner };
}

shortcutRoutes.get("/users/:username/shortcuts", authRequired, async (c) => {
  const currentUser = c.get("user");
  const resolved = await resolveOwner(c.env.DB, currentUser, c.req.param("username"));
  if (resolved.error) return c.json({ error: resolved.error.message }, resolved.error.status);

  const shortcuts = await loadShortcuts(c.env.DB, resolved.owner!);
  return c.json({ shortcuts: shortcuts.map(formatShortcut) });
});

shortcutRoutes.get("/users/:username/shortcuts/:id", authRequired, async (c) => {
  const currentUser = c.get("user");
  const resolved = await resolveOwner(c.env.DB, currentUser, c.req.param("username"));
  if (resolved.error) return c.json({ error: resolved.error.message }, resolved.error.status);

  const id = c.req.param("id");
  const shortcuts = await loadShortcuts(c.env.DB, resolved.owner!);
  const shortcut = shortcuts.find((item) => item.id === id);
  if (!shortcut) return c.json({ error: "Not found" }, 404);
  return c.json(formatShortcut(shortcut));
});

shortcutRoutes.post("/users/:username/shortcuts", authRequired, async (c) => {
  const currentUser = c.get("user");
  const resolved = await resolveOwner(c.env.DB, currentUser, c.req.param("username"));
  if (resolved.error) return c.json({ error: resolved.error.message }, resolved.error.status);

  const body = await c.req.json<Record<string, any>>();
  const shortcutInput = body.shortcut ?? body;
  const title = typeof shortcutInput.title === "string" ? shortcutInput.title.trim() : "";
  const filter = typeof shortcutInput.filter === "string" ? shortcutInput.filter.trim() : "";

  if (!title || !filter) {
    return c.json({ error: "Title and filter are required" }, 400);
  }
  const validationError = await validateShortcutFilter(c.env.DB, filter);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const shortcuts = await loadShortcuts(c.env.DB, resolved.owner!);
  const id = createShortcutId();

  const newShortcut = {
    id,
    name: buildShortcutName(resolved.owner!.username, id),
    title,
    filter,
  };
  shortcuts.push(newShortcut);

  await saveShortcuts(c.env.DB, resolved.owner!, shortcuts);
  return c.json(formatShortcut(newShortcut));
});

shortcutRoutes.patch("/users/:username/shortcuts/:id", authRequired, async (c) => {
  const currentUser = c.get("user");
  const resolved = await resolveOwner(c.env.DB, currentUser, c.req.param("username"));
  if (resolved.error) return c.json({ error: resolved.error.message }, resolved.error.status);

  const id = c.req.param("id");
  const body = await c.req.json<Record<string, any>>();
  const shortcutInput = body.shortcut ?? body;

  const shortcuts = await loadShortcuts(c.env.DB, resolved.owner!);
  const idx = shortcuts.findIndex((s) => s.id === id || getShortcutIdFromName(s.name) === id);
  if (idx === -1) return c.json({ error: "Not found" }, 404);

  const title = shortcutInput.title !== undefined ? String(shortcutInput.title).trim() : shortcuts[idx].title;
  const filter = shortcutInput.filter !== undefined ? String(shortcutInput.filter).trim() : shortcuts[idx].filter;
  if (!title || !filter) {
    return c.json({ error: "Title and filter are required" }, 400);
  }
  const validationError = await validateShortcutFilter(c.env.DB, filter);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  shortcuts[idx] = {
    id: shortcuts[idx].id,
    name: buildShortcutName(resolved.owner!.username, shortcuts[idx].id),
    title,
    filter,
  };
  await saveShortcuts(c.env.DB, resolved.owner!, shortcuts);
  return c.json(formatShortcut(shortcuts[idx]));
});

shortcutRoutes.delete("/users/:username/shortcuts/:id", authRequired, async (c) => {
  const currentUser = c.get("user");
  const resolved = await resolveOwner(c.env.DB, currentUser, c.req.param("username"));
  if (resolved.error) return c.json({ error: resolved.error.message }, resolved.error.status);

  const id = c.req.param("id");
  const shortcuts = await loadShortcuts(c.env.DB, resolved.owner!);

  const filtered = shortcuts.filter((s) => s.id !== id && getShortcutIdFromName(s.name) !== id);
  if (filtered.length === shortcuts.length) {
    return c.json({ error: "Not found" }, 404);
  }
  await saveShortcuts(c.env.DB, resolved.owner!, filtered);
  return c.json({});
});
