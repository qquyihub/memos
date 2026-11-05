export interface MemoRow {
  id: number;
  uid: string;
  creator_id: number;
  created_ts: number;
  updated_ts: number;
  row_status: string;
  content: string;
  visibility: string;
  pinned: number;
  payload: string;
  space_id?: number | null;
  space_uid?: string | null;
  creator_username?: string;
}

export interface ListMemosOpts {
  creatorId?: number;
  rowStatus?: string;
  visibility?: string;
  visibilities?: string[];
  excludeComments?: boolean;
  pinned?: boolean;
  contentSearch?: string;
  tagSearch?: string;
  createdTsAfter?: number;
  createdTsBefore?: number;
  filterWhere?: string;
  filterParams?: (string | number)[];
  pageSize?: number;
  offset?: number;
  orderBy?: string;
  readableByUserId?: number;
}

export async function createMemo(
  db: D1Database,
  data: {
    uid: string;
    creatorId: number;
    content: string;
    visibility: string;
    payload?: string;
    createdTs?: number;
    updatedTs?: number;
    pinned?: boolean;
    spaceId?: number | null;
  }
): Promise<MemoRow> {
  const payload = data.payload || "{}";
  const pinned = data.pinned ? 1 : 0;
  const spaceId = data.spaceId ?? null;

  let query: string;
  let params: (string | number | null)[];

  if (data.createdTs && data.updatedTs) {
    query = `INSERT INTO memo (uid, creator_id, content, visibility, payload, pinned, created_ts, updated_ts, space_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`;
    params = [data.uid, data.creatorId, data.content, data.visibility, payload, pinned, data.createdTs, data.updatedTs, spaceId];
  } else {
    query = `INSERT INTO memo (uid, creator_id, content, visibility, payload, pinned, space_id)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`;
    params = [data.uid, data.creatorId, data.content, data.visibility, payload, pinned, spaceId];
  }

  return (await db.prepare(query).bind(...params).first<MemoRow>())!;
}

const MEMO_SELECT = `SELECT memo.*, user.username AS creator_username, space.uid AS space_uid
  FROM memo LEFT JOIN user ON user.id = memo.creator_id LEFT JOIN space ON space.id = memo.space_id`;

export async function getMemoByUid(
  db: D1Database,
  uid: string
): Promise<MemoRow | null> {
  return db.prepare(`${MEMO_SELECT} WHERE memo.uid = ?`).bind(uid).first<MemoRow>();
}

export async function getMemoById(
  db: D1Database,
  id: number
): Promise<MemoRow | null> {
  return db.prepare(`${MEMO_SELECT} WHERE memo.id = ?`).bind(id).first<MemoRow>();
}

export async function listMemos(
  db: D1Database,
  opts: ListMemosOpts
): Promise<{ memos: MemoRow[]; hasNext: boolean }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.creatorId !== undefined) {
    conditions.push("memo.creator_id = ?");
    params.push(opts.creatorId);
  }
  if (opts.rowStatus) {
    conditions.push("memo.row_status = ?");
    params.push(opts.rowStatus);
  }
  if (opts.visibility) {
    conditions.push("memo.visibility = ?");
    params.push(opts.visibility);
  }
  if (opts.visibilities && opts.visibilities.length > 0) {
    const placeholders = opts.visibilities.map(() => "?").join(", ");
    conditions.push(`memo.visibility IN (${placeholders})`);
    params.push(...opts.visibilities);
  }
  if (opts.pinned !== undefined) {
    conditions.push("memo.pinned = ?");
    params.push(opts.pinned ? 1 : 0);
  }
  if (opts.excludeComments) {
    conditions.push("json_extract(memo.payload, '$.parent') IS NULL");
  }
  if (opts.contentSearch) {
    conditions.push("memo.content LIKE ?");
    params.push(`%${opts.contentSearch}%`);
  }
  if (opts.tagSearch) {
    conditions.push("memo.payload LIKE ?");
    params.push(`%${opts.tagSearch}%`);
  }
  if (opts.createdTsAfter !== undefined) {
    conditions.push("memo.created_ts >= ?");
    params.push(opts.createdTsAfter);
  }
  if (opts.createdTsBefore !== undefined) {
    conditions.push("memo.created_ts < ?");
    params.push(opts.createdTsBefore);
  }
  if (opts.filterWhere) {
    conditions.push(`(${opts.filterWhere})`);
    params.push(...(opts.filterParams || []));
  }
  if (opts.readableByUserId !== undefined) {
    conditions.push(
      `(memo.visibility IN ('PUBLIC', 'PROTECTED') OR memo.creator_id = ?
        OR (memo.visibility = 'SPACE' AND EXISTS (
          SELECT 1 FROM space_member sm JOIN user sm_user ON sm_user.id = sm.user_id AND sm_user.row_status = 'NORMAL'
          WHERE sm.space_id = memo.space_id AND sm.user_id = ? AND sm.status = 'ACTIVE' AND sm.role IN ('ADMIN', 'USER')
        )))`
    );
    params.push(opts.readableByUserId, opts.readableByUserId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const allowedOrderColumns = new Set(["id", "created_ts", "updated_ts", "pinned"]);
  const orderParts: string[] = [];
  if (opts.orderBy) {
    const parts = opts.orderBy.split(",").map((p) => p.trim());
    for (const part of parts) {
      const [field, dir] = part.split(" ");
      const col = field === "create_time" ? "created_ts" : field === "update_time" ? "updated_ts" : field;
      if (allowedOrderColumns.has(col)) {
        orderParts.push(`memo.${col} ${dir?.toUpperCase() === "ASC" ? "ASC" : "DESC"}`);
      }
    }
  }
  if (orderParts.length === 0) {
    orderParts.push("memo.pinned DESC", "memo.created_ts DESC");
  }
  // Stable ordering for pagination when timestamps tie.
  if (!orderParts.some((part) => part.startsWith("memo.id "))) {
    orderParts.push("memo.id DESC");
  }
  const orderClause = `ORDER BY ${orderParts.join(", ")}`;

  const pageSize = Math.max(1, Math.min(Math.trunc(opts.pageSize ?? 50), 1000));
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));

  // Fetch one extra row instead of running a COUNT(*) over the filtered set.
  // Counting was the dominant D1 cost for large memo lists and the API only
  // needs to know whether another page exists.
  const dataQuery = `${MEMO_SELECT} ${where} ${orderClause} LIMIT ? OFFSET ?`;
  const { results } = await db.prepare(dataQuery).bind(...params, pageSize + 1, offset).all<MemoRow>();

  const hasNext = results.length > pageSize;
  return { memos: hasNext ? results.slice(0, pageSize) : results, hasNext };
}

export async function updateMemo(
  db: D1Database,
  id: number,
  data: Partial<{
    content: string;
    visibility: string;
    pinned: number;
    row_status: string;
    payload: string;
    created_ts: number;
    updated_ts: number;
    space_id: number | null;
  }>
): Promise<MemoRow | null> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return getMemoById(db, id);

  if (!data.updated_ts) {
    fields.push("updated_ts = strftime('%s', 'now')");
  }
  values.push(id);

  const query = `UPDATE memo SET ${fields.join(", ")} WHERE id = ? RETURNING *`;
  return db.prepare(query).bind(...values).first<MemoRow>();
}

