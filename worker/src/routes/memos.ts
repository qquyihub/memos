import { Hono, type Context } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired, authOptional } from "../middleware/auth";
import * as memoDB from "../db/memo";
import * as relationDB from "../db/relation";
import * as reactionDB from "../db/reaction";
import * as shareDB from "../db/share";
import * as userDB from "../db/user";
import * as settingDB from "../db/setting";
import { createErrorBody } from "../error";
import { deleteCachedKeys, getCachedJson, putCachedJson, sha256Hex } from "../cache";
import { deleteStoredObjects } from "../storage";
import { buildMemoFilterWhere, MemoFilterError } from "../filter/memo-filter";
import {
  buildMemoSnippet,
  extractMemoPayloadData,
  extractMentions,
  type MemoPayloadData,
} from "../markdown";
import { deliverMemoCommentWebhook, deliverMemoWebhookEvent, getWebhookActor, type MemoWebhookEventType } from "../webhook";
import { publishMemoEvent } from "../events";

type MemoApp = { Bindings: Env; Variables: { user: UserPayload } };
type MemoContext = Context<MemoApp>;

export const memoRoutes = new Hono<MemoApp>();

const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

const getMemoContentLengthLimit = async (db: D1Database) => {
  const setting = await settingDB.getInstanceSetting(db, "MEMO_RELATED");
  if (!setting) {
    return 0;
  }
  try {
    const parsed = JSON.parse(setting.value) || {};
    return Number(parsed.contentLengthLimit) || 0;
  } catch {
    return 0;
  }
};

function generateUid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 22);
}

interface LinkMetadata {
  url?: string;
  title: string;
  description: string;
  image: string;
}

const MAX_LINK_METADATA_BATCH_SIZE = 10;
const MAX_LINK_METADATA_URL_LENGTH = 2048;
const MAX_LINK_METADATA_BYTES = 512 * 1024;
const LINK_METADATA_TIMEOUT_MS = 10_000;
const MAX_LINK_METADATA_REDIRECTS = 3;

function isBlockedLinkMetadataHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
    return true;
  }

  if (host.includes(":")) {
    // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10),
    // and IPv4-mapped addresses (which can bypass the IPv4 checks below).
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80:")
    );
  }

  const ipv4Parts = host.split(".");
  if (ipv4Parts.length !== 4) {
    return false;
  }

  const octets = ipv4Parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second, third] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function normalizeLinkMetadataUrl(rawUrl: string | undefined): string | undefined {
  const trimmedUrl = rawUrl?.trim();
  if (!trimmedUrl || trimmedUrl.length > MAX_LINK_METADATA_URL_LENGTH) {
    return undefined;
  }

  try {
    const url = new URL(trimmedUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || isBlockedLinkMetadataHostname(url.hostname)) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function emptyLinkMetadata(url?: string): LinkMetadata {
  return {
    ...(url ? { url } : {}),
    title: "",
    description: "",
    image: "",
  };
}

function parseMemoPayload(content: string): Pick<MemoPayloadData, "tags" | "property"> {
  const { tags, property } = extractMemoPayloadData(content);
  return { tags, property };
}

function formatMemo(memo: memoDB.MemoRow, creatorUsername?: string) {
  const payload = JSON.parse(memo.payload || "{}");
  if (payload.property && payload.property.hasIncompleteTasks === undefined && payload.property.hasIncompleteTask !== undefined) {
    payload.property.hasIncompleteTasks = Boolean(payload.property.hasIncompleteTask);
  }
  return {
    name: `memos/${memo.uid}`,
    state: memo.row_status === "ARCHIVED" ? "ARCHIVED" : "NORMAL",
    creator: `users/${creatorUsername || memo.creator_username || memo.creator_id}`,
    createTime: new Date(memo.created_ts * 1000).toISOString(),
    updateTime: new Date(memo.updated_ts * 1000).toISOString(),
    content: memo.content,
    visibility: memo.visibility,
    tags: payload.tags || [],
    pinned: memo.pinned === 1,
    property: payload.property || {},
    snippet: buildMemoSnippet(memo.content),
    ...(payload.parent ? { parent: payload.parent } : {}),
    ...(payload.location ? { location: payload.location } : {}),
  };
}

function getMemoReadDeniedStatus(memo: Pick<memoDB.MemoRow, "visibility" | "creator_id">, user: UserPayload | undefined): 401 | 403 | undefined {
  if (memo.visibility === "PRIVATE" && (!user || user.id !== memo.creator_id)) {
    return 403;
  }
  if (memo.visibility === "PROTECTED" && !user) {
    return 401;
  }
  return undefined;
}

function getMemoReadErrorMessage(status: 401 | 403): string {
  return status === 401 ? "Authentication required" : "Permission denied";
}

function formatMemoRelationSnippet(memo: Pick<memoDB.MemoRow, "uid" | "content" | "visibility" | "creator_id"> | undefined, user: UserPayload | undefined) {
  if (!memo || getMemoReadDeniedStatus(memo, user)) {
    return undefined;
  }
  return { name: `memos/${memo.uid}`, snippet: buildMemoSnippet(memo.content) };
}

function createPlaceholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.trunc(value));
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

/** Encode a page token the same way upstream `marshalPageToken` does. */
function encodePageToken(limit: number, offset: number): string {
  // protobuf PageToken{limit=1 int32, offset=2 int32}
  const bytes = [0x08, ...encodeVarint(limit), 0x10, ...encodeVarint(offset)];
  return btoa(String.fromCharCode(...bytes));
}

function decodeVarint(bytes: number[], start: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index];
    value |= (byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) {
      return { value, next: index };
    }
    shift += 7;
    if (shift > 28) {
      return undefined;
    }
  }
  return undefined;
}

function decodePageToken(token: string): { limit?: number; offset: number } {
  try {
    const decoded = atob(token);
    // Legacy local format: base64 of the numeric offset.
    if (/^\d+$/.test(decoded)) {
      return { offset: Math.max(0, Number(decoded)) };
    }
    // Legacy JSON format.
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded) as { limit?: unknown; offset?: unknown };
      return {
        limit: typeof parsed.limit === "number" ? parsed.limit : undefined,
        offset: typeof parsed.offset === "number" && Number.isFinite(parsed.offset) ? Math.max(0, Math.trunc(parsed.offset)) : 0,
      };
    }
    // Upstream protobuf format.
    const bytes = Array.from(decoded, (char) => char.charCodeAt(0));
    let cursor = 0;
    let limit: number | undefined;
    let offset = 0;
    while (cursor < bytes.length) {
      const tag = bytes[cursor++];
      const field = tag >> 3;
      const value = decodeVarint(bytes, cursor);
      if (!value) break;
      cursor = value.next;
      if (field === 1) limit = value.value;
      if (field === 2) offset = value.value;
    }
    return { limit, offset: Math.max(0, offset) };
  } catch {
    return { offset: 0 };
  }
}

function validateMemoOrderBy(orderBy: string): string | undefined {
  if (!orderBy.trim()) {
    return undefined;
  }
  for (const field of orderBy.split(",")) {
    const parts = field.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0];
    if (!["pinned", "create_time", "update_time", "name"].includes(name)) {
      return `unsupported order field: ${name}, supported fields are: pinned, create_time, update_time, name`;
    }
    if (parts.length > 1 && !["asc", "desc"].includes(parts[1].toLowerCase())) {
      return `invalid order direction: ${parts[1]}, must be 'asc' or 'desc'`;
    }
  }
  return undefined;
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Collect the memo id and its COMMENT descendants. In this schema a comment
 * relation is stored as (memo_id = parent, related_memo_id = comment).
 */
async function collectCommentTree(db: D1Database, rootId: number): Promise<number[]> {
  const all = new Set<number>([rootId]);
  let frontier = [rootId];

  while (frontier.length > 0) {
    const next: number[] = [];
    for (const chunk of chunkValues(frontier, 900)) {
      const { results } = await db.prepare(
        `SELECT related_memo_id FROM memo_relation WHERE type = 'COMMENT' AND memo_id IN (${createPlaceholders(chunk.length)})`
      ).bind(...chunk).all<{ related_memo_id: number }>();
      for (const row of results) {
        if (!all.has(row.related_memo_id)) {
          all.add(row.related_memo_id);
          next.push(row.related_memo_id);
        }
      }
    }
    frontier = next;
  }

  return [...all];
}

function formatAttachmentEntity(att: any, memoUid?: string) {
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
    size: String(att.size ?? 0),
    ...(memoUid ? { memo: `memos/${memoUid}` } : {}),
    ...(att.external_link ? { externalLink: att.external_link } : {}),
    ...(motionMedia ? { motionMedia } : {}),
  };
}

async function getMemoAttachments(db: D1Database, memoId: number, memoUid: string) {
  const { results } = await db.prepare("SELECT * FROM attachment WHERE memo_id = ? ORDER BY created_ts ASC").bind(memoId).all<any>();
  return results.map((att) => formatAttachmentEntity(att, memoUid));
}

async function getMemoRelations(db: D1Database, memoId: number, user?: UserPayload) {
  const relations = await listRelationsWithMemoByMemoIds(db, [memoId]);
  const resolved = relations.map((relation) => {
    const formattedRelation = {
      memo: formatMemoRelationSnippet(relationMemoRef(relation, "memo"), user),
      relatedMemo: formatMemoRelationSnippet(relationMemoRef(relation, "related"), user),
      type: relation.type,
    };
    return formattedRelation.memo && formattedRelation.relatedMemo ? formattedRelation : undefined;
  });
  return resolved.filter((relation) => relation !== undefined);
}

function formatReaction(reaction: reactionDB.ReactionRow, creatorUsername?: string) {
  return {
    name: `memos/${reaction.content_id}/reactions/${reaction.id}`,
    creator: `users/${creatorUsername || reaction.creator_id}`,
    contentId: `memos/${reaction.content_id}`,
    reactionType: reaction.reaction_type,
    createTime: new Date(reaction.created_ts * 1000).toISOString(),
  };
}

async function getMemoReactions(db: D1Database, memoUid: string) {
  const reactions = await reactionDB.listReactions(db, memoUid);
  return reactions.map((r) => formatReaction(r, r.creator_username));
}

function formatShare(share: shareDB.ShareRow, memoUid: string) {
  return {
    name: `memos/${memoUid}/shares/${share.uid}`,
    createTime: new Date(share.created_ts * 1000).toISOString(),
    ...(share.expires_ts ? { expireTime: new Date(share.expires_ts * 1000).toISOString() } : {}),
  };
}

async function enrichMemo(db: D1Database, memo: memoDB.MemoRow, creatorUsername?: string, user?: UserPayload) {
  const [attachments, relations, reactions] = await Promise.all([
    getMemoAttachments(db, memo.id, memo.uid),
    getMemoRelations(db, memo.id, user),
    getMemoReactions(db, memo.uid),
  ]);
  return {
    ...formatMemo(memo, creatorUsername),
    attachments,
    relations,
    reactions,
  };
}

async function listAttachmentRowsByMemoIds(db: D1Database, memoIds: number[]) {
  const rows: any[] = [];
  for (const chunk of chunkValues(memoIds, 900)) {
    const { results } = await db.prepare(
      `SELECT * FROM attachment WHERE memo_id IN (${createPlaceholders(chunk.length)}) ORDER BY memo_id ASC, created_ts ASC`
    ).bind(...chunk).all<any>();
    rows.push(...results);
  }
  return rows;
}

type MemoRefFields = Pick<memoDB.MemoRow, "uid" | "content" | "visibility" | "creator_id">;

interface RelationWithMemoRow {
  memo_id: number;
  related_memo_id: number;
  type: string;
  memo_uid: string;
  memo_content: string;
  memo_visibility: string;
  memo_creator_id: number;
  related_uid: string;
  related_content: string;
  related_visibility: string;
  related_creator_id: number;
}

function relationMemoRef(row: RelationWithMemoRow, side: "memo" | "related"): MemoRefFields {
  return side === "memo"
    ? { uid: row.memo_uid, content: row.memo_content, visibility: row.memo_visibility, creator_id: row.memo_creator_id }
    : { uid: row.related_uid, content: row.related_content, visibility: row.related_visibility, creator_id: row.related_creator_id };
}

/** Load relations together with both endpoint memos in a single query. */
async function listRelationsWithMemoByMemoIds(db: D1Database, memoIds: number[]): Promise<RelationWithMemoRow[]> {
  const rows: RelationWithMemoRow[] = [];
  const uniqueIds = [...new Set(memoIds)];
  if (uniqueIds.length === 0) {
    return rows;
  }

  for (const chunk of chunkValues(uniqueIds, 450)) {
    const placeholders = createPlaceholders(chunk.length);
    const { results } = await db.prepare(
      `SELECT r.type, r.memo_id, r.related_memo_id,
              source.uid AS memo_uid, source.content AS memo_content,
              source.visibility AS memo_visibility, source.creator_id AS memo_creator_id,
              target.uid AS related_uid, target.content AS related_content,
              target.visibility AS related_visibility, target.creator_id AS related_creator_id
       FROM memo_relation r
       JOIN memo source ON source.id = r.memo_id
       JOIN memo target ON target.id = r.related_memo_id
       WHERE r.memo_id IN (${placeholders}) OR r.related_memo_id IN (${placeholders})`
    ).bind(...chunk, ...chunk).all<RelationWithMemoRow>();
    rows.push(...results);
  }
  return rows;
}

async function listReactionRowsByContentIds(db: D1Database, contentIds: string[]) {
  const rows: reactionDB.ReactionRow[] = [];
  for (const chunk of chunkValues(contentIds, 900)) {
    const { results } = await db.prepare(
      `SELECT reaction.*, user.username AS creator_username
       FROM reaction LEFT JOIN user ON user.id = reaction.creator_id
       WHERE reaction.content_id IN (${createPlaceholders(chunk.length)})
       ORDER BY reaction.content_id ASC, reaction.created_ts ASC`
    ).bind(...chunk).all<reactionDB.ReactionRow>();
    rows.push(...results);
  }
  return rows;
}

async function getMemoRowMapByIds(db: D1Database, memoIds: number[]) {
  const memoMap = new Map<number, memoDB.MemoRow>();
  const uniqueIds = [...new Set(memoIds)].filter((id) => Number.isFinite(id));
  if (uniqueIds.length === 0) {
    return memoMap;
  }

  for (const chunk of chunkValues(uniqueIds, 900)) {
    const { results } = await db.prepare(
      `SELECT memo.*, user.username AS creator_username
       FROM memo LEFT JOIN user ON user.id = memo.creator_id
       WHERE memo.id IN (${createPlaceholders(chunk.length)})`
    ).bind(...chunk).all<memoDB.MemoRow>();
    for (const memo of results) {
      memoMap.set(memo.id, memo);
    }
  }
  return memoMap;
}

async function enrichMemos(db: D1Database, memos: memoDB.MemoRow[], user?: UserPayload) {
  if (memos.length === 0) {
    return [];
  }

  const memoIds = memos.map((m) => m.id);
  const memoUids = memos.map((m) => m.uid);
  const memoUidById = new Map(memos.map((m) => [m.id, m.uid]));
  const memoIdSet = new Set(memoIds);

  const [
    attachmentRows,
    relationRows,
    reactionRows,
  ] = await Promise.all([
    listAttachmentRowsByMemoIds(db, memoIds),
    listRelationsWithMemoByMemoIds(db, memoIds),
    listReactionRowsByContentIds(db, memoUids),
  ]);

  const attachmentsByMemoId = new Map<number, any[]>();
  for (const att of attachmentRows) {
    const memoUid = memoUidById.get(att.memo_id);
    if (!memoUid) continue;
    const attachments = attachmentsByMemoId.get(att.memo_id) || [];
    attachments.push(formatAttachmentEntity(att, memoUid));
    attachmentsByMemoId.set(att.memo_id, attachments);
  }

  const relationsByMemoId = new Map<number, any[]>();
  for (const relation of relationRows) {
    const formattedRelation = {
      memo: formatMemoRelationSnippet(relationMemoRef(relation, "memo"), user),
      relatedMemo: formatMemoRelationSnippet(relationMemoRef(relation, "related"), user),
      type: relation.type,
    };
    if (!formattedRelation.memo || !formattedRelation.relatedMemo) {
      continue;
    }

    if (memoIdSet.has(relation.memo_id)) {
      const relations = relationsByMemoId.get(relation.memo_id) || [];
      relations.push(formattedRelation);
      relationsByMemoId.set(relation.memo_id, relations);
    }
    if (memoIdSet.has(relation.related_memo_id) && relation.related_memo_id !== relation.memo_id) {
      const relations = relationsByMemoId.get(relation.related_memo_id) || [];
      relations.push(formattedRelation);
      relationsByMemoId.set(relation.related_memo_id, relations);
    }
  }

  const reactionsByContentId = new Map<string, ReturnType<typeof formatReaction>[]>();
  for (const reaction of reactionRows) {
    const reactions = reactionsByContentId.get(reaction.content_id) || [];
    reactions.push(formatReaction(reaction, reaction.creator_username));
    reactionsByContentId.set(reaction.content_id, reactions);
  }

  return memos.map((memo) => ({
    ...formatMemo(memo),
    attachments: attachmentsByMemoId.get(memo.id) || [],
    relations: relationsByMemoId.get(memo.id) || [],
    reactions: reactionsByContentId.get(memo.uid) || [],
  }));
}

async function invalidateMemoDerivedCaches(cache: KVNamespace | undefined, usernames: Array<string | undefined>) {
  const keys = ["user:stats:all", "user:stats:all:public", "instance:stats"];
  for (const username of usernames) {
    if (username) {
      keys.push(`user:stats:${username}`);
      keys.push(`user:stats:${username}:public`);
      keys.push(`user:stats:${username}:authenticated`);
      keys.push(`user:stats:${username}:owner`);
    }
  }
  await deleteCachedKeys(cache, keys);
}

function enqueueMemoWebhook(
  c: MemoContext,
  eventType: MemoWebhookEventType,
  creatorId: number,
  memo: unknown,
  actor: UserPayload,
) {
  c.executionCtx.waitUntil(
    deliverMemoWebhookEvent({
      db: c.env.DB,
      creatorId,
      eventType,
      memo,
      actor: getWebhookActor(actor),
    }),
  );
}

interface MentionMemoContext {
  uid: string;
  creator_id: number;
  visibility: string;
  content: string;
}

async function resolveMentionTargets(db: D1Database, content: string) {
  const usernames = extractMentions(content);
  if (usernames.length === 0) {
    return [];
  }
  const users = await userDB.findUsersByUsernames(db, usernames);
  return users.filter((user) => user.row_status === "NORMAL");
}

function shouldSkipMentionInbox(
  target: userDB.UserRow,
  memo: MentionMemoContext,
  relatedMemo?: MentionMemoContext,
): boolean {
  if (target.id === memo.creator_id) {
    return true;
  }
  // Comment creation already notifies the parent creator separately.
  if (relatedMemo && target.id === relatedMemo.creator_id && memo.visibility !== "PRIVATE" && memo.creator_id !== relatedMemo.creator_id) {
    return true;
  }
  if (relatedMemo && relatedMemo.visibility === "PRIVATE" && target.id !== relatedMemo.creator_id) {
    return true;
  }
  return memo.visibility === "PRIVATE" && target.id !== memo.creator_id;
}

async function getParentMemoContext(
  db: D1Database,
  memo: Pick<memoDB.MemoRow, "payload">,
): Promise<{ uid: string; creator_id: number; visibility: string } | undefined> {
  try {
    const parentName = JSON.parse(memo.payload || "{}").parent;
    if (typeof parentName !== "string" || !parentName.startsWith("memos/")) {
      return undefined;
    }
    const parentUid = parentName.slice("memos/".length);
    const parent = await db.prepare("SELECT uid, creator_id, visibility FROM memo WHERE uid = ?")
      .bind(parentUid)
      .first<{ uid: string; creator_id: number; visibility: string }>();
    return parent ?? undefined;
  } catch {
    return undefined;
  }
}

async function publishMemoUpdatedEvent(db: D1Database, memo: memoDB.MemoRow): Promise<void> {
  const parent = await getParentMemoContext(db, memo);
  await publishMemoEvent(db, {
    type: "memo.updated",
    name: `memos/${memo.uid}`,
    parent: parent ? `memos/${parent.uid}` : undefined,
    visibility: memo.visibility,
    creatorId: parent?.creator_id ?? memo.creator_id,
  });
}

async function dispatchMentionNotifications(
  db: D1Database,
  memo: MentionMemoContext,
  relatedMemo?: MentionMemoContext,
  previousContent = "",
): Promise<void> {
  const currentTargets = await resolveMentionTargets(db, memo.content);
  if (currentTargets.length === 0) {
    return;
  }

  const previousTargets = previousContent ? await resolveMentionTargets(db, previousContent) : [];
  const previousTargetIds = new Set(previousTargets.map((user) => user.id));

  for (const target of currentTargets) {
    if (previousTargetIds.has(target.id) || shouldSkipMentionInbox(target, memo, relatedMemo)) {
      continue;
    }

    const message = JSON.stringify({
      type: "MEMO_MENTION",
      memo: `memos/${memo.uid}`,
      ...(relatedMemo ? { relatedMemo: `memos/${relatedMemo.uid}` } : {}),
      memoSnippet: buildMemoSnippet(memo.content),
      ...(relatedMemo ? { relatedMemoSnippet: buildMemoSnippet(relatedMemo.content) } : {}),
    });

    try {
      await db.prepare(
        "INSERT INTO inbox (sender_id, receiver_id, status, message) VALUES (?, ?, ?, ?)"
      ).bind(memo.creator_id, target.id, "UNREAD", message).run();
    } catch (error) {
      console.warn("Failed to create mention inbox notification", error);
    }
  }
}

function getAttachmentReference(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const attachment = value as { name?: unknown; uid?: unknown; id?: unknown };
    if (typeof attachment.name === "string") return attachment.name;
    if (typeof attachment.uid === "string") return attachment.uid;
    if (typeof attachment.id === "number" || typeof attachment.id === "string") return String(attachment.id);
  }
  return "";
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/g, (match, dec: string) => {
      const code = parseInt(dec, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function parseMetaTags(html: string): Map<string, string> {
  const metaMap = new Map<string, string>();
  const metaRegex = /<meta\s+([^>]*?)\s*\/?>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attributes: Record<string, string> = {};
    const attributeRegex = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributeRegex.exec(metaMatch[1])) !== null) {
      attributes[attributeMatch[1].toLowerCase()] = attributeMatch[3] ?? attributeMatch[4] ?? attributeMatch[5] ?? "";
    }

    const key = (attributes.property || attributes.name || "").trim().toLowerCase();
    if (key && attributes.content && !metaMap.has(key)) {
      metaMap.set(key, decodeHtmlEntities(attributes.content).trim());
    }
  }
  return metaMap;
}

async function readResponseTextLimited(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) {
    return "";
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.slice(0, maxBytes - total));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

async function fetchLinkMetadataHtml(url: string): Promise<string | undefined> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_LINK_METADATA_REDIRECTS; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_METADATA_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(currentUrl, {
        headers: { "User-Agent": "cfmemos-bot/1.0", Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        return undefined;
      }
      let nextUrl: string | undefined;
      try {
        nextUrl = normalizeLinkMetadataUrl(new URL(location, currentUrl).toString());
      } catch {
        return undefined;
      }
      if (!nextUrl) {
        return undefined;
      }
      currentUrl = nextUrl;
      continue;
    }

    if (!resp.ok) {
      return undefined;
    }

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return undefined;
    }

    const declaredLength = Number(resp.headers.get("content-length") || 0);
    if (declaredLength > MAX_LINK_METADATA_BYTES) {
      return undefined;
    }

    return await readResponseTextLimited(resp, MAX_LINK_METADATA_BYTES);
  }

  return undefined;
}

async function getLinkMetadata(env: Env, url: string, includeUrl = false): Promise<LinkMetadata> {
  const cacheKey = `link-metadata:${await sha256Hex(url)}`;
  const cached = await getCachedJson<LinkMetadata>(env.CACHE, cacheKey);
  if (cached) {
    return includeUrl ? { ...cached, url } : cached;
  }

  let metadata: LinkMetadata;
  try {
    const html = await fetchLinkMetadataHtml(url);
    if (!html) {
      metadata = { title: "", description: "", image: "" };
    } else {
      const metaTags = parseMetaTags(html);
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
      const title = (metaTags.get("og:title") || metaTags.get("twitter:title") || decodeHtmlEntities(titleTag)).trim();
      const description = (metaTags.get("og:description") || metaTags.get("description") || metaTags.get("twitter:description") || "").trim();
      let image = (metaTags.get("og:image") || metaTags.get("og:image:url") || metaTags.get("twitter:image") || "").trim();

      if (image) {
        try {
          image = new URL(image, url).toString();
        } catch {
          image = "";
        }
      }

      metadata = {
        title: title.slice(0, 300),
        description: description.slice(0, 1000),
        image: image.slice(0, MAX_LINK_METADATA_URL_LENGTH),
      };
    }
  } catch {
    metadata = { title: "", description: "", image: "" };
  }

  await putCachedJson(env.CACHE, cacheKey, metadata, 60 * 60 * 24 * 14);
  return includeUrl ? { ...metadata, url } : metadata;
}

async function resolveAttachmentIds(db: D1Database, user: UserPayload, references: unknown[]): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<number>();
  const tokens: string[] = [];

  for (const referenceValue of references) {
    const reference = getAttachmentReference(referenceValue);
    if (!reference) continue;

    const token = reference.startsWith("attachments/") ? reference.slice("attachments/".length) : reference;
    tokens.push(token);
  }

  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) {
    return ids;
  }

  const rowsByUid = new Map<string, { id: number; uid: string; creator_id: number }>();
  const rowsById = new Map<number, { id: number; uid: string; creator_id: number }>();

  for (const tokenChunk of chunkValues(uniqueTokens, 450)) {
    const numericIds = tokenChunk
      .map((token) => Number(token))
      .filter((id) => Number.isInteger(id) && id > 0);
    const uidPlaceholders = createPlaceholders(tokenChunk.length);
    const conditions = [`uid IN (${uidPlaceholders})`];
    const params: Array<string | number> = [...tokenChunk];

    if (numericIds.length > 0) {
      conditions.push(`id IN (${createPlaceholders(numericIds.length)})`);
      params.push(...numericIds);
    }

    const { results } = await db.prepare(
      `SELECT id, uid, creator_id FROM attachment WHERE ${conditions.join(" OR ")}`
    ).bind(...params).all<{ id: number; uid: string; creator_id: number }>();

    for (const row of results) {
      rowsByUid.set(row.uid, row);
      rowsById.set(row.id, row);
    }
  }

  for (const token of tokens) {
    const row = rowsByUid.get(token) || rowsById.get(Number(token));
    if (!row) continue;
    if (row.creator_id !== user.id && user.role !== "ADMIN") continue;
    if (!seen.has(row.id)) {
      ids.push(row.id);
      seen.add(row.id);
    }
  }

  return ids;
}

async function setMemoAttachments(env: Env, memoId: number, user: UserPayload, references: unknown[]) {
  const db = env.DB;
  const attachmentIds = await resolveAttachmentIds(db, user, references);
  const keepIds = new Set(attachmentIds);

  // Upstream `setMemoAttachmentsInternal` removes attachments that are no
  // longer part of the requested set instead of leaving them orphaned.
  const { results: previousAttachments } = await db.prepare(
    "SELECT id, reference, storage_type FROM attachment WHERE memo_id = ?"
  ).bind(memoId).all<{ id: number; reference: string; storage_type: string }>();
  const removedAttachments = previousAttachments.filter((attachment) => !keepIds.has(attachment.id));
  if (removedAttachments.length > 0) {
    await deleteStoredObjects(env, db, removedAttachments);
    await db.prepare(
      `DELETE FROM attachment WHERE id IN (${createPlaceholders(removedAttachments.length)})`
    ).bind(...removedAttachments.map((attachment) => attachment.id)).run();
  }

  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE attachment SET memo_id = NULL WHERE memo_id = ?").bind(memoId),
  ];
  for (const chunk of chunkValues(attachmentIds, 900)) {
    const placeholders = createPlaceholders(chunk.length);
    statements.push(
      user.role === "ADMIN"
        ? db.prepare(`UPDATE attachment SET memo_id = ? WHERE id IN (${placeholders})`).bind(memoId, ...chunk)
        : db.prepare(`UPDATE attachment SET memo_id = ? WHERE id IN (${placeholders}) AND creator_id = ?`).bind(memoId, ...chunk, user.id),
    );
  }
  statements.push(db.prepare("UPDATE memo SET updated_ts = strftime('%s', 'now') WHERE id = ?").bind(memoId));

  await db.batch(statements);
}

async function setMemoRelations(
  db: D1Database,
  memo: memoDB.MemoRow,
  relations: Array<{ memo?: { name?: string }; relatedMemo?: { name?: string }; relatedMemoId?: number; type?: string | number }>,
): Promise<void> {
  const normalized: { relatedMemoId: number; type: string }[] = [];
  for (const relation of relations || []) {
    let relatedToken: unknown = relation.relatedMemoId;
    if (relation.memo?.name || relation.relatedMemo?.name) {
      const memoName = relation.memo?.name;
      const relatedName = relation.relatedMemo?.name;
      relatedToken = memoName === `memos/${memo.uid}` ? relatedName : memoName;
    }
    const relatedMemoId = await resolveMemoIdByToken(db, relatedToken);
    if (!relatedMemoId || relatedMemoId === memo.id) continue;
    normalized.push({ relatedMemoId, type: normalizeRelationType(relation.type) });
  }
  // COMMENT relations are managed by comment creation/deletion, never by the client.
  const referenceRelations = normalized.filter((relation) => relation.type !== "COMMENT");
  await relationDB.setRelations(db, memo.id, referenceRelations);
  await db.prepare("UPDATE memo SET updated_ts = strftime('%s', 'now') WHERE id = ?").bind(memo.id).run();
}

// Create memo
memoRoutes.post("/", authRequired, async (c) => {
  const user = c.get("user");
  const rawBody = await c.req.json();
  const body = rawBody.memo ?? rawBody;
  const { content, visibility, createTime, updateTime, location } = body;

  if (!content && content !== "") {
    return c.json({ error: "Content is required" }, 400);
  }

  const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
  if (contentLengthLimit > 0 && getUtf8ByteLength(content || "") > contentLengthLimit) {
    return c.json(
      createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
        errorKey: "message.memo-content-too-long",
        errorParams: { size: contentLengthLimit },
      }),
      400,
    );
  }

  const requestedMemoId = c.req.query("memoId");
  const uid = requestedMemoId || generateUid();
  const payload = {
    ...parseMemoPayload(content || ""),
    ...(location ? { location } : {}),
  };

  const createdTs = createTime ? Math.floor(new Date(createTime).getTime() / 1000) : undefined;
  const updatedTs = updateTime ? Math.floor(new Date(updateTime).getTime() / 1000) : undefined;

  const memo = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content: content || "",
    visibility: visibility || "PRIVATE",
    payload: JSON.stringify(payload),
    createdTs,
    updatedTs,
  });

  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    await setMemoAttachments(c.env, memo.id, user, body.attachments);
  }

  await invalidateMemoDerivedCaches(c.env.CACHE, [user.username]);
  const enrichedMemo = await enrichMemo(c.env.DB, memo, user.username, user);
  enqueueMemoWebhook(c, "memos.memo.created", memo.creator_id, enrichedMemo, user);
  await dispatchMentionNotifications(c.env.DB, memo);
  await publishMemoEvent(c.env.DB, {
    type: "memo.created",
    name: `memos/${memo.uid}`,
    visibility: memo.visibility,
    creatorId: memo.creator_id,
  });
  return c.json(enrichedMemo);
});

// List memos
memoRoutes.get("/", authOptional, async (c) => {
  const user = c.get("user");
  const rawPageSize = Math.max(1, Math.min(Number(c.req.query("pageSize")) || 10, 1000));
  const pageToken = c.req.query("pageToken");
  const filter = c.req.query("filter") || "";
  const orderBy = c.req.query("orderBy") || "";
  const state = c.req.query("state") || "NORMAL";
  const isArchived = state === "ARCHIVED";

  if (isArchived && !user) {
    return c.json({ memos: [], nextPageToken: "" });
  }

  const orderByError = validateMemoOrderBy(orderBy);
  if (orderByError) {
    return c.json(createErrorBody(`invalid order_by: ${orderByError}`, { errorKey: "message.invalid-memo-order-by" }), 400);
  }

  const decodedToken = pageToken ? decodePageToken(pageToken) : undefined;
  const pageSize = Math.max(1, Math.min(decodedToken?.limit || rawPageSize, 1000));
  const offset = decodedToken?.offset ?? 0;

  const opts: memoDB.ListMemosOpts = {
    pageSize,
    offset,
    orderBy,
    rowStatus: isArchived ? "ARCHIVED" : "NORMAL",
    excludeComments: true,
  };

  if (filter) {
    try {
      const compiledFilter = await buildMemoFilterWhere(c.env.DB, filter);
      opts.filterWhere = compiledFilter.sql;
      opts.filterParams = compiledFilter.params;
    } catch (error) {
      const message = error instanceof MemoFilterError ? error.message : "Invalid memo filter";
      return c.json(
        createErrorBody(message, {
          errorKey: "message.invalid-memo-filter",
          errorParams: { filter },
        }),
        400,
      );
    }
  }

  if (isArchived) {
    opts.creatorId = user!.id;
  } else if (!user) {
    opts.visibility = "PUBLIC";
  } else {
    opts.readableByUserId = user.id;
  }

  const { memos, hasNext } = await memoDB.listMemos(c.env.DB, opts);

  const nextPageToken = hasNext ? encodePageToken(pageSize, offset + pageSize) : "";

  return c.json({
    memos: await enrichMemos(c.env.DB, memos, user),
    nextPageToken,
  });
});

// Get memo by ID (supports both numeric id and uid)
memoRoutes.get("/:id", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }

  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  return c.json(await enrichMemo(c.env.DB, memo, memo.creator_username, user));
});

// Update memo
memoRoutes.patch("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const body = await c.req.json();

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const updateData: Parameters<typeof memoDB.updateMemo>[2] = {};
  const rawUpdateMask = c.req.query("updateMask") || c.req.query("update_mask") || "";
  const updateMask = rawUpdateMask ? new Set(rawUpdateMask.split(",").map((field) => field.trim()).filter(Boolean)) : undefined;
  const canUpdate = (field: string) => !updateMask || updateMask.has(field);
  let previousContent = "";

  if (canUpdate("content") && body.content !== undefined) {
    previousContent = memo.content;
    const contentLengthLimit = await getMemoContentLengthLimit(c.env.DB);
    if (contentLengthLimit > 0 && getUtf8ByteLength(body.content) > contentLengthLimit) {
      return c.json(
        createErrorBody(`Memo content exceeds the maximum allowed length of ${contentLengthLimit} bytes.`, {
          errorKey: "message.memo-content-too-long",
          errorParams: { size: contentLengthLimit },
        }),
        400,
      );
    }
    updateData.content = body.content;
    const payload = parseMemoPayload(body.content);
    const existingPayload = JSON.parse(memo.payload || "{}");
    updateData.payload = JSON.stringify({ ...existingPayload, ...payload });
  }
  if (canUpdate("location") && body.location !== undefined) {
    const existingPayload = JSON.parse((updateData.payload as string) || memo.payload || "{}");
    updateData.payload = JSON.stringify({
      ...existingPayload,
      ...(body.location ? { location: body.location } : { location: null }),
    });
  }
  if (canUpdate("visibility") && body.visibility !== undefined) updateData.visibility = body.visibility;
  if (canUpdate("pinned") && body.pinned !== undefined) updateData.pinned = body.pinned ? 1 : 0;
  if (canUpdate("state") && (body.state !== undefined || body.rowStatus !== undefined)) {
    updateData.row_status = body.state ?? body.rowStatus;
  }
  if (canUpdate("createTime") && body.createTime) updateData.created_ts = Math.floor(new Date(body.createTime).getTime() / 1000);
  if (canUpdate("updateTime") && body.updateTime) updateData.updated_ts = Math.floor(new Date(body.updateTime).getTime() / 1000);

  const updated = await memoDB.updateMemo(c.env.DB, memo.id, updateData);
  if (!updated) {
    return c.json({ error: "Update failed" }, 500);
  }

  if (canUpdate("attachments") && Array.isArray(body.attachments)) {
    await setMemoAttachments(c.env, memo.id, user, body.attachments);
  }
  if (canUpdate("relations") && Array.isArray(body.relations)) {
    await setMemoRelations(c.env.DB, memo, body.relations);
  }

  const refreshed = (await memoDB.getMemoById(c.env.DB, memo.id)) ?? updated;
  const creatorName = memo.creator_username || (updated.creator_id === user.id ? user.username : undefined);
  await invalidateMemoDerivedCaches(c.env.CACHE, [creatorName]);
  if (previousContent) {
    await dispatchMentionNotifications(c.env.DB, refreshed, undefined, previousContent);
  }
  const enrichedMemo = await enrichMemo(c.env.DB, refreshed, creatorName, user);
  enqueueMemoWebhook(c, "memos.memo.updated", updated.creator_id, enrichedMemo, user);
  const parent = await getParentMemoContext(c.env.DB, refreshed);
  await publishMemoEvent(c.env.DB, {
    type: "memo.updated",
    name: `memos/${refreshed.uid}`,
    parent: parent ? `memos/${parent.uid}` : undefined,
    visibility: refreshed.visibility,
    creatorId: parent?.creator_id ?? refreshed.creator_id,
  });
  return c.json(enrichedMemo);
});

// Delete memo
memoRoutes.delete("/:id", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  let memo: memoDB.MemoRow | null;
  if (/^\d+$/.test(id)) {
    memo = await memoDB.getMemoById(c.env.DB, Number(id));
  } else {
    memo = await memoDB.getMemoByUid(c.env.DB, id);
  }

  if (!memo) {
    return c.json({ error: "Memo not found" }, 404);
  }
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const creatorName = memo.creator_username || (memo.creator_id === user.id ? user.username : undefined);
  const deletedMemo = await enrichMemo(c.env.DB, memo, creatorName, user);
  const parent = await getParentMemoContext(c.env.DB, memo);

  // Delete the memo together with its comment subtree and all derived rows.
  // R2/S3 blobs are removed first, then the database rows are cleaned in one
  // D1 batch per chunk to keep the operation atomic and fast.
  const memoIds = await collectCommentTree(c.env.DB, memo.id);
  for (const chunk of chunkValues(memoIds, 400)) {
    const memoPlaceholders = createPlaceholders(chunk.length);

    const { results: uidRows } = await c.env.DB.prepare(
      `SELECT uid FROM memo WHERE id IN (${memoPlaceholders})`
    ).bind(...chunk).all<{ uid: string }>();
    const contentIds = uidRows.map((row) => row.uid);

    const { results: memoAttachments } = await c.env.DB.prepare(
      `SELECT id, reference, storage_type FROM attachment WHERE memo_id IN (${memoPlaceholders})`
    ).bind(...chunk).all<{ id: number; reference: string; storage_type: string }>();
    if (memoAttachments.length > 0) {
      await deleteStoredObjects(c.env, c.env.DB, memoAttachments);
    }

    const statements: D1PreparedStatement[] = [];
    if (contentIds.length > 0) {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM reaction WHERE content_id IN (${createPlaceholders(contentIds.length)})`
        ).bind(...contentIds),
      );
    }
    statements.push(
      c.env.DB.prepare(`DELETE FROM memo_share WHERE memo_id IN (${memoPlaceholders})`).bind(...chunk),
      c.env.DB.prepare(
        `DELETE FROM memo_relation WHERE memo_id IN (${memoPlaceholders}) OR related_memo_id IN (${memoPlaceholders})`
      ).bind(...chunk, ...chunk),
      c.env.DB.prepare(`DELETE FROM attachment WHERE memo_id IN (${memoPlaceholders})`).bind(...chunk),
      c.env.DB.prepare(`DELETE FROM memo WHERE id IN (${memoPlaceholders})`).bind(...chunk),
    );
    await c.env.DB.batch(statements);
  }

  await invalidateMemoDerivedCaches(c.env.CACHE, [creatorName]);
  enqueueMemoWebhook(c, "memos.memo.deleted", memo.creator_id, deletedMemo, user);
  await publishMemoEvent(c.env.DB, {
    type: "memo.deleted",
    name: `memos/${memo.uid}`,
    parent: parent ? `memos/${parent.uid}` : undefined,
    visibility: memo.visibility,
    creatorId: parent?.creator_id ?? memo.creator_id,
  });
  return c.json({});
});

// --- Memo Relations ---
memoRoutes.get("/:id/relations", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const relations = await getMemoRelations(c.env.DB, memo.id, user);
  return c.json({ relations, nextPageToken: "" });
});

function normalizeRelationType(value: unknown): string {
  if (typeof value === "number") {
    return value === 2 ? "COMMENT" : "REFERENCE";
  }
  if (typeof value === "string" && value) {
    return value.toUpperCase();
  }
  return "REFERENCE";
}

async function resolveMemoIdByToken(db: D1Database, token: unknown): Promise<number | undefined> {
  if (typeof token !== "string" && typeof token !== "number") {
    return undefined;
  }
  const raw = String(token);
  const uid = raw.startsWith("memos/") ? raw.slice("memos/".length) : raw;
  const row = await db.prepare("SELECT id FROM memo WHERE uid = ? OR id = ?")
    .bind(uid, Number(uid) || 0)
    .first<{ id: number }>();
  return row?.id;
}

memoRoutes.patch("/:id/relations", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{
    relations?: Array<{ memo?: { name?: string }; relatedMemo?: { name?: string }; relatedMemoId?: number; type?: string | number }>;
  }>();
  await setMemoRelations(c.env.DB, memo, body.relations || []);
  await publishMemoUpdatedEvent(c.env.DB, memo);
  return c.json({});
});

// --- Memo Comments ---
memoRoutes.post("/:id/comments", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const parentMemo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!parentMemo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(parentMemo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const rawBody = await c.req.json();
  const body = rawBody.comment ?? rawBody;
  const uid = c.req.query("commentId") || generateUid();
  const payload = {
    ...parseMemoPayload(body.content || ""),
    ...(body.location ? { location: body.location } : {}),
  };

  const comment = await memoDB.createMemo(c.env.DB, {
    uid,
    creatorId: user.id,
    content: body.content || "",
    visibility: body.visibility || "PRIVATE",
    payload: JSON.stringify({
      ...payload,
      parent: `memos/${parentMemo.uid}`,
    }),
  });

  if (Array.isArray(body.attachments) && body.attachments.length > 0) {
    await setMemoAttachments(c.env, comment.id, user, body.attachments);
  }

  await relationDB.createRelation(c.env.DB, {
    memoId: parentMemo.id,
    relatedMemoId: comment.id,
    type: "COMMENT",
  });

  if (comment.visibility !== "PRIVATE" && parentMemo.creator_id !== user.id) {
    const message = JSON.stringify({
      type: "MEMO_COMMENT",
      memo: `memos/${comment.uid}`,
      relatedMemo: `memos/${parentMemo.uid}`,
      memoSnippet: buildMemoSnippet(comment.content),
      relatedMemoSnippet: buildMemoSnippet(parentMemo.content),
    });
    await c.env.DB.prepare(
      "INSERT INTO inbox (sender_id, receiver_id, status, message) VALUES (?, ?, ?, ?)"
    ).bind(user.id, parentMemo.creator_id, "UNREAD", message).run();
  }

  await invalidateMemoDerivedCaches(c.env.CACHE, [user.username]);
  const enrichedComment = await enrichMemo(c.env.DB, comment, user.username, user);
  c.executionCtx.waitUntil(
    deliverMemoCommentWebhook({
      db: c.env.DB,
      creatorId: parentMemo.creator_id,
      memo: enrichedComment,
      actor: getWebhookActor(user),
    }),
  );
  await dispatchMentionNotifications(c.env.DB, comment, parentMemo);
  await publishMemoEvent(c.env.DB, {
    type: "memo.comment.created",
    name: `memos/${parentMemo.uid}`,
    visibility: parentMemo.visibility,
    creatorId: parentMemo.creator_id,
  });
  return c.json(enrichedComment);
});

memoRoutes.get("/:id/comments", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const relations = await relationDB.listRelations(c.env.DB, memo.id);
  const commentRelations = relations.filter((r) => r.type === "COMMENT");
  const commentMap = await getMemoRowMapByIds(c.env.DB, commentRelations.map((rel) => rel.related_memo_id));
  const comments: memoDB.MemoRow[] = [];
  for (const rel of commentRelations) {
    const comment = commentMap.get(rel.related_memo_id);
    if (comment && !getMemoReadDeniedStatus(comment, user)) comments.push(comment);
  }

  return c.json({
    memos: await enrichMemos(c.env.DB, comments, user),
    nextPageToken: "",
    totalSize: comments.length,
  });
});

// --- Memo Reactions ---
memoRoutes.get("/:id/reactions", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const reactions = await getMemoReactions(c.env.DB, memo.uid);
  return c.json({ reactions });
});

memoRoutes.post("/:id/reactions", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const body = await c.req.json<{
    reaction?: { reactionType?: string; contentId?: string };
    reactionType?: string;
  }>();
  const reactionType = body.reaction?.reactionType ?? body.reactionType;
  if (!reactionType) {
    return c.json({ error: "Reaction type is required" }, 400);
  }
  const reaction = await reactionDB.upsertReaction(c.env.DB, {
    creatorId: user.id,
    contentId: memo.uid,
    reactionType,
  });
  const parent = await getParentMemoContext(c.env.DB, memo);
  await publishMemoEvent(c.env.DB, {
    type: "reaction.upserted",
    name: `memos/${memo.uid}`,
    parent: parent ? `memos/${parent.uid}` : undefined,
    visibility: memo.visibility,
    creatorId: parent?.creator_id ?? memo.creator_id,
  });
  return c.json(formatReaction(reaction, user.username));
});

memoRoutes.delete("/:id/reactions/:reactionId", authRequired, async (c) => {
  const reactionId = Number(c.req.param("reactionId"));
  const user = c.get("user");

  const reaction = await reactionDB.getReactionById(c.env.DB, reactionId);
  if (!reaction || (reaction.creator_id !== user.id && user.role !== "ADMIN")) {
    // 403 instead of 404 to avoid revealing whether the reaction exists.
    return c.json({ error: "Permission denied" }, 403);
  }

  await reactionDB.deleteReaction(c.env.DB, reactionId, reaction.creator_id);
  const memo = await memoDB.getMemoByUid(c.env.DB, reaction.content_id);
  if (memo) {
    const parent = await getParentMemoContext(c.env.DB, memo);
    await publishMemoEvent(c.env.DB, {
      type: "reaction.deleted",
      name: `memos/${memo.uid}`,
      parent: parent ? `memos/${parent.uid}` : undefined,
      visibility: memo.visibility,
      creatorId: parent?.creator_id ?? memo.creator_id,
    });
  }
  return c.json({});
});

// --- Memo Shares ---
memoRoutes.get("/:id/shares", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const shares = await shareDB.listShares(c.env.DB, memo.id);
  return c.json({ memoShares: shares.map((s) => formatShare(s, memo.uid)) });
});

memoRoutes.post("/:id/shares", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const rawBody = await c.req.json<{
    memoShare?: { expireTime?: string };
    expireTime?: string;
    expiresTs?: number;
  }>();
  const memoShare = rawBody.memoShare ?? rawBody;
  const expiresTs = memoShare.expireTime
    ? Math.floor(new Date(memoShare.expireTime).getTime() / 1000)
    : rawBody.expiresTs;
  if (typeof expiresTs === "number" && Number.isFinite(expiresTs) && expiresTs <= Math.floor(Date.now() / 1000)) {
    return c.json({ error: "expire_time must be in the future" }, 400);
  }
  const normalizedExpiresTs = typeof expiresTs === "number" && Number.isFinite(expiresTs) ? expiresTs : undefined;
  const share = await shareDB.createShare(c.env.DB, {
    memoId: memo.id,
    creatorId: user.id,
    expiresTs: normalizedExpiresTs,
  });
  return c.json(formatShare(share, memo.uid));
});

memoRoutes.delete("/:id/shares/:shareId", authRequired, async (c) => {
  const id = c.req.param("id");
  const shareId = c.req.param("shareId");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  await shareDB.deleteShare(c.env.DB, shareId, memo.id);
  return c.json({});
});

// --- Memo Attachments ---
memoRoutes.get("/:id/attachments", authOptional, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  const deniedStatus = getMemoReadDeniedStatus(memo, user);
  if (deniedStatus) {
    return c.json({ error: getMemoReadErrorMessage(deniedStatus) }, deniedStatus);
  }

  const attachments = await getMemoAttachments(c.env.DB, memo.id, memo.uid);
  return c.json({ attachments, nextPageToken: "" });
});

memoRoutes.patch("/:id/attachments", authRequired, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const memo = /^\d+$/.test(id)
    ? await memoDB.getMemoById(c.env.DB, Number(id))
    : await memoDB.getMemoByUid(c.env.DB, id);
  if (!memo) return c.json({ error: "Memo not found" }, 404);
  if (memo.creator_id !== user.id && user.role !== "ADMIN") {
    return c.json({ error: "Permission denied" }, 403);
  }

  const body = await c.req.json<{ attachmentIds?: Array<number | string>; attachments?: unknown[] }>();
  await setMemoAttachments(c.env, memo.id, user, body.attachments || body.attachmentIds || []);
  await publishMemoUpdatedEvent(c.env.DB, memo);

  return c.json({});
});

// --- Link metadata ---
memoRoutes.get("/-/linkMetadata", async (c) => {
  const url = normalizeLinkMetadataUrl(c.req.query("url"));
  if (!url) return c.json({ error: "URL required" }, 400);

  return c.json(await getLinkMetadata(c.env, url));
});

memoRoutes.post("/-/linkMetadata\\:batchGet", async (c) => {
  const body = await c.req.json<{ urls: string[] }>();
  const urls = (body.urls || []).slice(0, MAX_LINK_METADATA_BATCH_SIZE);

  const linkMetadata = await Promise.all(
    urls.map((url) => {
      const normalizedUrl = normalizeLinkMetadataUrl(url);
      return normalizedUrl ? getLinkMetadata(c.env, normalizedUrl, true) : emptyLinkMetadata(url);
    }),
  );

  return c.json({ linkMetadata });
});

// --- Get memo by share token ---
export const shareRoutes = new Hono<MemoApp>();

shareRoutes.get("/shares/:shareId", authOptional, async (c) => {
  const token = c.req.param("shareId");
  const share = await shareDB.getShareByUid(c.env.DB, token);

  // Invalid, expired, and archived shares deliberately look identical so
  // callers cannot probe for existence, matching upstream `GetMemoByShare`.
  if (!share || (share.expires_ts && share.expires_ts < Math.floor(Date.now() / 1000))) {
    return c.json({ error: "not found" }, 404);
  }

  const memo = await memoDB.getMemoById(c.env.DB, share.memo_id);
  if (!memo || memo.row_status === "ARCHIVED") {
    return c.json({ error: "not found" }, 404);
  }

  return c.json(await enrichMemo(c.env.DB, memo, memo.creator_username));
});
