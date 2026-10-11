-- Existing sessions have no credential binding and require one fresh sign-in after this upgrade.
ALTER TABLE admin_sessions ADD COLUMN auth_method text CHECK (auth_method IN ('password','feishu'));
ALTER TABLE admin_sessions ADD COLUMN auth_binding text;
CREATE TABLE admin_login_states (
  id_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE TABLE admin_password_attempts (
  id bigserial PRIMARY KEY,
  client_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_password_attempts_time_idx ON admin_password_attempts(attempted_at);
