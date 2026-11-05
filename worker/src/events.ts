export type MemoEventType =
  | "memo.created"
  | "memo.updated"
  | "memo.deleted"
  | "memo.comment.created"
  | "reaction.upserted"
  | "reaction.deleted";

export interface MemoEventInput {
  type: MemoEventType;
  /** Resource name affected by the event, e.g. `memos/abc`. */
  name: string;
  /** Parent memo name when the affected resource is a comment. */
  parent?: string;
  visibility: string;
  creatorId: number;
}

export interface MemoEventRow {
  id: number;
  type: MemoEventType;
  name: string;
  parent: string;
  visibility: string;
  creator_id: number;
}

const EVENT_RETENTION_SECONDS = 10 * 60;
const MAX_EVENT_FETCH = 200;

/**
 * Persist a short-lived refresh event. Unlike an in-process hub this survives
 * Worker isolate boundaries, which is why the SSE endpoint polls D1.
 */
export async function publishMemoEvent(db: D1Database, event: MemoEventInput): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare(
      "INSERT INTO memo_event (type, name, parent, visibility, creator_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(event.type, event.name, event.parent || "", event.visibility, event.creatorId),
  ];

  // Occasionally prune old rows so the table stays tiny.
  if (Math.random() < 0.05) {
    statements.push(
      db.prepare("DELETE FROM memo_event WHERE created_ts < ?")
        .bind(Math.floor(Date.now() / 1000) - EVENT_RETENTION_SECONDS),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    // Real-time refresh is best effort and must never fail the mutation.
    console.warn("Failed to publish memo event", error);
  }
}

export async function getLatestMemoEventId(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM memo_event").first<{ id: number }>();
  return row?.id ?? 0;
}

export async function listMemoEventsAfter(db: D1Database, lastId: number): Promise<MemoEventRow[]> {
  const { results } = await db.prepare(
    `SELECT id, type, name, parent, visibility, creator_id
     FROM memo_event
     WHERE id > ? AND created_ts >= ?
     ORDER BY id ASC
     LIMIT ?`
  )
    .bind(lastId, Math.floor(Date.now() / 1000) - EVENT_RETENTION_SECONDS, MAX_EVENT_FETCH)
    .all<MemoEventRow>();
  return results;
}

export function canReceiveMemoEvent(event: MemoEventRow, userId: number, role: string): boolean {
  if (event.visibility === "PRIVATE") {
    return event.creator_id === userId || role === "ADMIN";
  }
  return true;
}
