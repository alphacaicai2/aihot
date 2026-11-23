-- Google's immutable subject identifies a reader even if their email changes.
CREATE TABLE readers (
  google_subject text PRIMARY KEY,
  email text NOT NULL
);

CREATE TABLE reader_sessions (
  id_hash text PRIMARY KEY,
  google_subject text NOT NULL REFERENCES readers (google_subject) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX reader_sessions_expiry_idx ON reader_sessions (expires_at);
