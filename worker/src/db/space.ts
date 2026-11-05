export interface SpaceRow {
  id: number;
  uid: string;
  title: string;
  description: string;
  payload: string;
  current_user_role?: string;
  member_count?: number;
}

export interface SpaceMemberRow {
  space_id: number;
  user_id: number;
  status: string;
  role: string;
  username: string;
  nickname: string;
  row_status: string;
}

export interface SpaceInvitationRow {
  space_id: number;
  user_id: number;
  role: string;
  username: string;
  nickname: string;
  row_status: string;
}

const SPACE_SELECT = `SELECT space.id, space.uid, space.title, space.description, space.payload`;

export async function createSpace(
  db: D1Database,
  data: { uid: string; title: string; description: string; payload: string },
  creatorId: number,
): Promise<SpaceRow> {
  const space = await db
    .prepare(
      "INSERT INTO space (uid, title, description, payload) VALUES (?, ?, ?, ?) RETURNING id, uid, title, description, payload"
    )
    .bind(data.uid, data.title, data.description, data.payload)
    .first<SpaceRow>();

  if (!space) {
    throw new Error("Failed to create space");
  }

  await db
    .prepare("INSERT INTO space_member (space_id, user_id, status, role) VALUES (?, ?, 'ACTIVE', 'ADMIN')")
    .bind(space.id, creatorId)
    .run();

  return { ...space, current_user_role: "ADMIN", member_count: 1 };
}

export async function listSpacesForUser(db: D1Database, userId: number): Promise<SpaceRow[]> {
  const { results } = await db
    .prepare(
      `${SPACE_SELECT}, viewer.role AS current_user_role,
        (SELECT COUNT(*) FROM space_member active_member
          JOIN user active_user ON active_user.id = active_member.user_id AND active_user.row_status = 'NORMAL'
          WHERE active_member.space_id = space.id AND active_member.status = 'ACTIVE'
            AND active_member.role IN ('ADMIN', 'USER')) AS member_count
       FROM space
       JOIN space_member viewer ON viewer.space_id = space.id
       JOIN user viewer_user ON viewer_user.id = viewer.user_id AND viewer_user.row_status = 'NORMAL'
       WHERE viewer.user_id = ? AND viewer.status = 'ACTIVE' AND viewer.role IN ('ADMIN', 'USER')
       ORDER BY space.id DESC`
    )
    .bind(userId)
    .all<SpaceRow>();
  return results;
}

export async function getSpaceByUid(db: D1Database, uid: string, viewerId?: number): Promise<SpaceRow | null> {
  if (viewerId !== undefined) {
    return db
      .prepare(
        `${SPACE_SELECT}, viewer.role AS current_user_role,
          (SELECT COUNT(*) FROM space_member active_member
            JOIN user active_user ON active_user.id = active_member.user_id AND active_user.row_status = 'NORMAL'
            WHERE active_member.space_id = space.id AND active_member.status = 'ACTIVE'
              AND active_member.role IN ('ADMIN', 'USER')) AS member_count
         FROM space
         JOIN space_member viewer ON viewer.space_id = space.id
         JOIN user viewer_user ON viewer_user.id = viewer.user_id AND viewer_user.row_status = 'NORMAL'
         WHERE space.uid = ? AND viewer.user_id = ? AND viewer.status = 'ACTIVE' AND viewer.role IN ('ADMIN', 'USER')`
      )
      .bind(uid, viewerId)
      .first<SpaceRow>();
  }

  return db.prepare(`${SPACE_SELECT} FROM space WHERE uid = ?`).bind(uid).first<SpaceRow>();
}

export async function getSpaceById(db: D1Database, id: number): Promise<SpaceRow | null> {
  return db.prepare(`${SPACE_SELECT} FROM space WHERE id = ?`).bind(id).first<SpaceRow>();
}

export async function updateSpace(
  db: D1Database,
  id: number,
  data: Partial<{ title: string; description: string; payload: string }>,
): Promise<SpaceRow | null> {
  const fields: string[] = [];
  const values: (string | number)[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) {
    return getSpaceById(db, id);
  }

  values.push(id);
  return db
    .prepare(`UPDATE space SET ${fields.join(", ")} WHERE id = ? RETURNING id, uid, title, description, payload`)
    .bind(...values)
    .first<SpaceRow>();
}

export async function deleteSpace(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM space WHERE id = ?").bind(id).run();
}

export async function getSpaceMember(db: D1Database, spaceId: number, userId: number): Promise<SpaceMemberRow | null> {
  return db
    .prepare(
      `SELECT sm.space_id, sm.user_id, sm.status, sm.role, u.username, u.nickname, u.row_status
       FROM space_member sm JOIN user u ON u.id = sm.user_id
       WHERE sm.space_id = ? AND sm.user_id = ?`
    )
    .bind(spaceId, userId)
    .first<SpaceMemberRow>();
}

export async function listSpaceMembers(db: D1Database, spaceId: number): Promise<SpaceMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sm.space_id, sm.user_id, sm.status, sm.role, u.username, u.nickname, u.row_status
       FROM space_member sm JOIN user u ON u.id = sm.user_id
       WHERE sm.space_id = ? AND sm.status = 'ACTIVE' AND u.row_status = 'NORMAL'
       ORDER BY sm.role ASC, u.username ASC`
    )
    .bind(spaceId)
    .all<SpaceMemberRow>();
  return results;
}

export async function countActiveAdmins(db: D1Database, spaceId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM space_member sm
       JOIN user u ON u.id = sm.user_id
       WHERE sm.space_id = ? AND sm.status = 'ACTIVE' AND sm.role = 'ADMIN' AND u.row_status = 'NORMAL'`
    )
    .bind(spaceId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function updateSpaceMemberRole(
  db: D1Database,
  spaceId: number,
  userId: number,
  role: string,
): Promise<void> {
  await db
    .prepare("UPDATE space_member SET role = ? WHERE space_id = ? AND user_id = ? AND status = 'ACTIVE'")
    .bind(role, spaceId, userId)
    .run();
}

export async function deleteSpaceMember(db: D1Database, spaceId: number, userId: number): Promise<void> {
  await db.prepare("DELETE FROM space_member WHERE space_id = ? AND user_id = ?").bind(spaceId, userId).run();
}

export async function createSpaceInvitation(
  db: D1Database,
  spaceId: number,
  userId: number,
  role: string,
): Promise<SpaceInvitationRow> {
  await db
    .prepare("INSERT INTO space_member (space_id, user_id, status, role) VALUES (?, ?, 'INVITED', ?)")
    .bind(spaceId, userId, role)
    .run();

  const row = await getSpaceInvitation(db, spaceId, userId);
  if (!row) {
    throw new Error("Failed to create space invitation");
  }
  return row;
}

export async function getSpaceInvitation(
  db: D1Database,
  spaceId: number,
  userId: number,
): Promise<SpaceInvitationRow | null> {
  return db
    .prepare(
      `SELECT sm.space_id, sm.user_id, sm.role, u.username, u.nickname, u.row_status
       FROM space_member sm JOIN user u ON u.id = sm.user_id
       WHERE sm.space_id = ? AND sm.user_id = ? AND sm.status = 'INVITED'`
    )
    .bind(spaceId, userId)
    .first<SpaceInvitationRow>();
}

export async function listSpaceInvitations(db: D1Database, spaceId: number): Promise<SpaceInvitationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT sm.space_id, sm.user_id, sm.role, u.username, u.nickname, u.row_status
       FROM space_member sm JOIN user u ON u.id = sm.user_id
       WHERE sm.space_id = ? AND sm.status = 'INVITED' AND u.row_status = 'NORMAL'
       ORDER BY u.username ASC`
    )
    .bind(spaceId)
    .all<SpaceInvitationRow>();
  return results;
}

export async function listUserInvitations(db: D1Database, userId: number): Promise<Array<SpaceInvitationRow & { space_uid: string }>> {
  const { results } = await db
    .prepare(
      `SELECT sm.space_id, sm.user_id, sm.role, u.username, u.nickname, u.row_status, space.uid AS space_uid
       FROM space_member sm
       JOIN user u ON u.id = sm.user_id
       JOIN space ON space.id = sm.space_id
       WHERE sm.user_id = ? AND sm.status = 'INVITED' AND u.row_status = 'NORMAL'
       ORDER BY space.id DESC`
    )
    .bind(userId)
    .all<SpaceInvitationRow & { space_uid: string }>();
  return results;
}

export async function acceptSpaceInvitation(db: D1Database, spaceId: number, userId: number): Promise<SpaceMemberRow | null> {
  await db
    .prepare("UPDATE space_member SET status = 'ACTIVE' WHERE space_id = ? AND user_id = ? AND status = 'INVITED'")
    .bind(spaceId, userId)
    .run();
  return getSpaceMember(db, spaceId, userId);
}

export async function deleteSpaceInvitation(db: D1Database, spaceId: number, userId: number): Promise<void> {
  await db
    .prepare("DELETE FROM space_member WHERE space_id = ? AND user_id = ? AND status = 'INVITED'")
    .bind(spaceId, userId)
    .run();
}

export async function isActiveSpaceMember(db: D1Database, spaceId: number, userId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM space_member sm
       JOIN user u ON u.id = sm.user_id AND u.row_status = 'NORMAL'
       WHERE sm.space_id = ? AND sm.user_id = ? AND sm.status = 'ACTIVE' AND sm.role IN ('ADMIN', 'USER')`
    )
    .bind(spaceId, userId)
    .first<{ ok: number }>();
  return Boolean(row);
}

export async function getActiveSpaceIdsForUser(db: D1Database, userId: number): Promise<Set<number>> {
  const { results } = await db
    .prepare(
      `SELECT sm.space_id FROM space_member sm
       JOIN user u ON u.id = sm.user_id AND u.row_status = 'NORMAL'
       WHERE sm.user_id = ? AND sm.status = 'ACTIVE' AND sm.role IN ('ADMIN', 'USER')`
    )
    .bind(userId)
    .all<{ space_id: number }>();
  return new Set(results.map((row) => row.space_id));
}

export async function userBelongsToAnySpace(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM space_member WHERE user_id = ? AND status = 'ACTIVE' LIMIT 1")
    .bind(userId)
    .first<{ ok: number }>();
  return Boolean(row);
}

export async function deleteMemosInSpace(db: D1Database, spaceId: number): Promise<Array<Record<string, unknown>>> {
  const { results: attachments } = await db
    .prepare("SELECT * FROM attachment WHERE memo_id IN (SELECT id FROM memo WHERE space_id = ?)")
    .bind(spaceId)
    .all<Record<string, unknown>>();

  await db.prepare("DELETE FROM reaction WHERE content_id IN (SELECT uid FROM memo WHERE space_id = ?)").bind(spaceId).run();
  await db.prepare("DELETE FROM memo_share WHERE memo_id IN (SELECT id FROM memo WHERE space_id = ?)").bind(spaceId).run();
  await db.prepare(
    "DELETE FROM memo_relation WHERE memo_id IN (SELECT id FROM memo WHERE space_id = ?) OR related_memo_id IN (SELECT id FROM memo WHERE space_id = ?)"
  ).bind(spaceId, spaceId).run();
  await db.prepare("DELETE FROM attachment WHERE memo_id IN (SELECT id FROM memo WHERE space_id = ?)").bind(spaceId).run();
  await db.prepare("DELETE FROM memo WHERE space_id = ?").bind(spaceId).run();

  return attachments;
}
