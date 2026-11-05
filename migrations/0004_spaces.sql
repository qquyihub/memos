-- Align with upstream memos 26.11: Spaces, SPACE visibility and memo placement.

CREATE TABLE IF NOT EXISTS space (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS space_member (
  space_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('INVITED', 'ACTIVE')),
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'USER')),
  PRIMARY KEY (space_id, user_id),
  FOREIGN KEY (space_id) REFERENCES space(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_space_member_user_id ON space_member(user_id, space_id);

-- SQLite cannot widen an existing CHECK constraint, so rebuild `memo` to
-- accept the SPACE audience and carry a nullable space placement.
CREATE TABLE memo_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PROTECTED', 'PRIVATE', 'SPACE')) DEFAULT 'PRIVATE',
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)) DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  space_id INTEGER DEFAULT NULL
);

INSERT INTO memo_new (id, uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload, space_id)
SELECT id, uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload, NULL FROM memo;

-- Preserve share rows while the referenced `memo` table is rebuilt.
CREATE TABLE memo_share_backup AS SELECT * FROM memo_share;

DROP TABLE memo_share;
DROP TABLE memo;

ALTER TABLE memo_new RENAME TO memo;

CREATE TABLE memo_share (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  memo_id INTEGER NOT NULL,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  expires_ts BIGINT DEFAULT NULL,
  FOREIGN KEY (memo_id) REFERENCES memo(id) ON DELETE CASCADE
);

INSERT INTO memo_share (id, uid, memo_id, creator_id, created_ts, expires_ts)
SELECT id, uid, memo_id, creator_id, created_ts, expires_ts FROM memo_share_backup;

DROP TABLE memo_share_backup;

CREATE INDEX IF NOT EXISTS idx_memo_share_memo_id ON memo_share(memo_id);

CREATE INDEX IF NOT EXISTS idx_memo_status_pinned_created
  ON memo(row_status, pinned, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_creator_status_pinned_created
  ON memo(creator_id, row_status, pinned, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_visibility_status_created
  ON memo(visibility, row_status, created_ts DESC);

CREATE INDEX IF NOT EXISTS idx_memo_space_id
  ON memo(space_id, row_status, created_ts DESC, id DESC);
