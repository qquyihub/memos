import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authOptional, authRequired } from "../middleware/auth";
import { createErrorBody } from "../error";
import { deleteCachedKeys } from "../cache";
import {
  appendUniqueSuffix,
  createStorageBackend,
  deleteStoredObjects,
  getStorageConfig,
  getUploadPolicy,
  renderObjectKey,
} from "../storage";

type AttApp = { Bindings: Env; Variables: { user: UserPayload } };

export const attachmentRoutes = new Hono<AttApp>();

export interface AttachmentRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  filename: string;
  type: string;
  size: number;
  memo_id: number | null;
  storage_type: string;
  reference: string;
  payload: string;
  external_link?: string;
}

const nowTs = () => Math.floor(Date.now() / 1000);

function formatAttachment(att: AttachmentRow, memoUid?: string | null) {
  let motionMedia: unknown;
  try {
    motionMedia = att.payload ? JSON.parse(att.payload).motionMedia : undefined;
  } catch {
    motionMedia = undefined;
  }

  return {
    name: `attachments/${att.uid}`,
    createTime: new Date(att.created_ts * 1000).toISOString(),
    filename: att.filename,
    type: att.type,
    size: String(att.size),
    ...(memoUid ? { memo: `memos/${memoUid}` } : {}),
    ...(att.external_link ? { externalLink: att.external_link } : {}),
    ...(motionMedia ? { motionMedia } : {}),
  };
}

async function findMemoUidById(db: D1Database, memoId: number | null): Promise<string | null> {
  if (!memoId) return null;
  const row = await db.prepare("SELECT uid FROM memo WHERE id = ?").bind(memoId).first<{ uid: string }>();
  return row?.uid ?? null;
}

function decodeBase64Content(content: string): ArrayBuffer {
  const base64 = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

type MemoTargetResolution = { memoId: number | null } | { error: string; status: 403 | 404 };

async function resolveWritableMemoId(db: D1Database, user: UserPayload, memoName?: string | number | null): Promise<MemoTargetResolution> {
  if (memoName === undefined || memoName === null || memoName === "") {
    return { memoId: null };
  }

  const memoToken = String(memoName);
  const uid = memoToken.startsWith("memos/") ? memoToken.slice("memos/".length) : memoToken;
  const memo = await db.prepare("SELECT id, creator_id FROM memo WHERE uid = ? OR id = ?")
    .bind(uid, Number(uid) || 0)
    .first<{ id: number; creator_id: number }>();
  if (!memo) {
    return { error: "Memo not found", status: 404 };
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return { error: "Permission denied", status: 403 };
  }
  return { memoId: memo.id };
}

async function findAttachmentByToken(db: D1Database, token: string): Promise<AttachmentRow | null> {
  const normalized = token.startsWith("attachments/") ? token.slice("attachments/".length) : token;
  return db.prepare("SELECT * FROM attachment WHERE uid = ? OR id = ?")
    .bind(normalized, Number(normalized) || 0)
    .first<AttachmentRow>();
}

function createPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function findAttachmentsByTokens(db: D1Database, tokens: string[]): Promise<AttachmentRow[]> {
  const normalizedTokens = [...new Set(tokens.map((token) => token.startsWith("attachments/") ? token.slice("attachments/".length) : token).filter(Boolean))];
  const attachmentsById = new Map<number, AttachmentRow>();
  if (normalizedTokens.length === 0) {
    return [];
  }

  for (const tokenChunk of chunkValues(normalizedTokens, 450)) {
    const numericIds = tokenChunk
      .map((token) => Number(token))
      .filter((id) => Number.isInteger(id) && id > 0);
    const conditions = [`uid IN (${createPlaceholders(tokenChunk.length)})`];
    const params: Array<string | number> = [...tokenChunk];

    if (numericIds.length > 0) {
      conditions.push(`id IN (${createPlaceholders(numericIds.length)})`);
      params.push(...numericIds);
    }

    const { results } = await db.prepare(
      `SELECT * FROM attachment WHERE ${conditions.join(" OR ")}`
    ).bind(...params).all<AttachmentRow>();
    for (const attachment of results) {
      attachmentsById.set(attachment.id, attachment);
    }
  }

  return [...attachmentsById.values()];
}

async function findMemoUids(db: D1Database, attachments: AttachmentRow[]): Promise<Map<number, string>> {
  const referencedIds = [...new Set(attachments.map((att) => att.memo_id).filter((id): id is number => typeof id === "number" && id > 0))];
  const memoUids = new Map<number, string>();
  if (referencedIds.length === 0) {
    return memoUids;
  }

  for (const chunk of chunkValues(referencedIds, 900)) {
    const { results } = await db.prepare(
      `SELECT id, uid FROM memo WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<{ id: number; uid: string }>();
    for (const row of results) {
      memoUids.set(row.id, row.uid);
    }
  }

  return memoUids;
}

async function getAttachmentReadDeniedStatus(db: D1Database, att: AttachmentRow, user: UserPayload | undefined): Promise<401 | 403 | undefined> {
  if (!att.memo_id) {
    return user && (att.creator_id === user.id || user.role === "ADMIN") ? undefined : 403;
  }

  const memo = await db.prepare("SELECT visibility, creator_id FROM memo WHERE id = ?")
    .bind(att.memo_id)
    .first<{ visibility: string; creator_id: number }>();
  if (!memo) {
    return user && (att.creator_id === user.id || user.role === "ADMIN") ? undefined : 403;
  }
  if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
    return 403;
  }
  if (memo.visibility === "PROTECTED" && !user) {
    return 401;
  }
  return undefined;
}

const SHORT_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateShortId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length]).join("");
}

async function attachmentReferenceExists(db: D1Database, reference: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS found FROM attachment WHERE reference = ? LIMIT 1").bind(reference).first<{ found: number }>();
  return Boolean(row);
}

async function buildUniqueObjectKey(
  db: D1Database,
  policy: { filepathTemplate: string },
  context: { username: string; uid: string; filename: string; mimeType: string; timestamp: number },
): Promise<string> {
  const render = (shortId: string) =>
    renderObjectKey({
      template: policy.filepathTemplate,
      username: context.username,
      uid: context.uid,
      shortId,
      filename: context.filename,
      mimeType: context.mimeType,
      timestamp: context.timestamp,
    });

  const baseKey = render(generateShortId()) || `attachments/${context.uid}`;
  let objectKey = baseKey;
  let counter = 1;

  while (await attachmentReferenceExists(db, objectKey)) {
    if (counter > 1000) {
      throw new Error("Failed to generate a unique object key");
    }
    objectKey = appendUniqueSuffix(baseKey, counter);
    counter += 1;
  }

  return objectKey;
}

// Upload attachment
attachmentRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const contentType = c.req.header("content-type") || "";
  const uploadPolicy = await getUploadPolicy(c.env.DB);
  const maxUploadSizeMb = uploadPolicy.uploadSizeLimitMb;
  const maxUploadSize = maxUploadSizeMb * 1024 * 1024;

  let filename: string;
  let fileType: string;
  let fileData: ArrayBuffer;
  let memoId: number | null = null;
  let motionMedia: unknown;

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = (formData.get("file") || formData.get("attachment") || formData.get("content")) as File | null;
    if (!file) return c.json({ error: "No file provided" }, 400);
    if (file.size > maxUploadSize) {
      return c.json(
        createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
          errorKey: "message.maximum-upload-size-is",
          errorParams: { size: maxUploadSizeMb },
        }),
        413,
      );
    }
    filename = file.name;
    fileType = file.type;
    fileData = await file.arrayBuffer();
    const rawMotionMedia = formData.get("motionMedia")?.toString();
    if (rawMotionMedia) {
      try {
        motionMedia = JSON.parse(rawMotionMedia);
      } catch {
        motionMedia = undefined;
      }
    }
    const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, formData.get("memo")?.toString() || null);
    if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);
    memoId = resolvedMemo.memoId;
  } else {
    const body = await c.req.json();
    const attachment = body.attachment || body;
    filename = attachment.filename || "unnamed";
    fileType = attachment.type || "application/octet-stream";
    motionMedia = attachment.motionMedia;
    const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, attachment.memo);
    if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);
    memoId = resolvedMemo.memoId;

    if (attachment.content) {
      fileData = decodeBase64Content(attachment.content);
      if (fileData.byteLength > maxUploadSize) {
        return c.json(
          createErrorBody(`File too large. Maximum upload size is ${maxUploadSizeMb}MB.`, {
            errorKey: "message.maximum-upload-size-is",
            errorParams: { size: maxUploadSizeMb },
          }),
          413,
        );
      }
    } else {
      return c.json({ error: "No content provided" }, 400);
    }
  }

  const uid = c.req.query("attachmentId") || c.req.query("attachment_id") || crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const createdTs = nowTs();
  const objectKey = await buildUniqueObjectKey(c.env.DB, uploadPolicy, {
    username: user.username,
    uid,
    filename,
    mimeType: fileType,
    timestamp: createdTs,
  });

  const storageConfig = await getStorageConfig(c.env.DB);
  const storage = createStorageBackend(c.env, storageConfig);
  await storage.put(objectKey, fileData, fileType);

  // Store metadata in D1
  const payload = motionMedia ? JSON.stringify({ motionMedia }) : "{}";
  const att = await c.env.DB.prepare(
    `INSERT INTO attachment (uid, creator_id, created_ts, updated_ts, filename, type, size, memo_id, storage_type, reference, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  )
    .bind(uid, user.id, createdTs, createdTs, filename, fileType, fileData.byteLength, memoId, storageConfig.storageType, objectKey, payload)
    .first<AttachmentRow>();

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json(formatAttachment(att!, await findMemoUidById(c.env.DB, att!.memo_id)));
});

// List attachments
attachmentRoutes.get("/", authRequired, async (c) => {
  const user = c.get("user");
  const pageSize = Math.min(Number(c.req.query("pageSize")) || 50, 1000);
  const pageToken = c.req.query("pageToken");
  const filter = c.req.query("filter") || "";
  let offset = 0;
  if (pageToken) {
    try { offset = Number(atob(pageToken)); } catch {}
  }

  const whereConditions = ["creator_id = ?"];
  const params: (string | number | null)[] = [user.id];

  if (filter.includes("memo_id == null") || filter.includes("memo == null")) {
    whereConditions.push("(memo_id IS NULL OR memo_id NOT IN (SELECT id FROM memo))");
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM attachment ${whereClause}`
  ).bind(...params).first<{ total: number }>();
  const total = countResult?.total ?? 0;

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM attachment ${whereClause} ORDER BY created_ts DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all<AttachmentRow>();

  const nextPageToken = offset + pageSize < total ? btoa(String(offset + pageSize)) : "";

  const memoUids = await findMemoUids(c.env.DB, results);

  return c.json({
    attachments: results.map((att) =>
      formatAttachment(att, att.memo_id !== null ? memoUids.get(att.memo_id) : null)
    ),
    nextPageToken,
    totalSize: total,
  });
});

// Get attachment
attachmentRoutes.get("/:id", authOptional, async (c) => {
  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  const deniedStatus = await getAttachmentReadDeniedStatus(c.env.DB, att, c.get("user"));
  if (deniedStatus) {
    return c.json({ error: deniedStatus === 401 ? "Authentication required" : "Permission denied" }, deniedStatus);
  }
  return c.json(formatAttachment(att, await findMemoUidById(c.env.DB, att.memo_id)));
});

// Update attachment
attachmentRoutes.patch("/:id", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ attachment?: { filename?: string; memoId?: number | null; memo?: string | null }; filename?: string; memoId?: number | null; memo?: string | null }>();
  const attachmentInput = body.attachment ?? body;

  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  if (att.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (attachmentInput.filename !== undefined) { updates.push("filename = ?"); params.push(attachmentInput.filename); }
  if (attachmentInput.memoId !== undefined || attachmentInput.memo !== undefined) {
    const resolvedMemo = await resolveWritableMemoId(c.env.DB, user, attachmentInput.memo ?? attachmentInput.memoId ?? null);
    if ("error" in resolvedMemo) return c.json({ error: resolvedMemo.error }, resolvedMemo.status);
    updates.push("memo_id = ?");
    params.push(resolvedMemo.memoId);
  }

  if (updates.length > 0) {
    updates.push("updated_ts = strftime('%s', 'now')");
    params.push(att.id);
    await c.env.DB.prepare(`UPDATE attachment SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...params).run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM attachment WHERE id = ?")
    .bind(att.id).first<AttachmentRow>();
  return c.json(formatAttachment(updated!, await findMemoUidById(c.env.DB, updated!.memo_id)));
});

// Delete attachment
attachmentRoutes.delete("/:id", authRequired, async (c) => {
  const user = c.get("user");

  const att = await findAttachmentByToken(c.env.DB, c.req.param("id"));
  if (!att) return c.json({ error: "Not found" }, 404);
  if (att.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  await deleteStoredObjects(c.env, c.env.DB, [att]);

  await c.env.DB.prepare("DELETE FROM attachment WHERE id = ?").bind(att.id).run();
  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json({});
});

// Batch delete
export const attachmentActionRoutes = new Hono<AttApp>();

attachmentActionRoutes.post("/attachments\\:batchDelete", authRequired, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ ids?: Array<number | string>; names?: string[] }>();

  const attachments = await findAttachmentsByTokens(c.env.DB, (body.names || body.ids || []).map(String));
  const deletableAttachments = attachments.filter((att) => att.creator_id === user.id || user.role === "ADMIN");

  await deleteStoredObjects(c.env, c.env.DB, deletableAttachments);

  const attachmentIds = deletableAttachments.map((att) => att.id);
  for (const chunk of chunkValues(attachmentIds, 900)) {
    await c.env.DB.prepare(
      `DELETE FROM attachment WHERE id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).run();
  }

  await deleteCachedKeys(c.env.CACHE, ["instance:stats"]);
  return c.json({});
});
