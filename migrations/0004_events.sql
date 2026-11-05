-- Short-lived change log used to stream SSE refresh events across Worker
-- isolates. D1 is the only shared store available in the default deployment,
-- so events are persisted briefly and polled by /api/v1/sse.
CREATE TABLE IF NOT EXISTS memo_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  parent TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT '',
  creator_id INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memo_event_created_ts ON memo_event(created_ts);
