-- Earlier framework installations stored admin sessions without an authentication method.
-- Deployments that already bind their sessions keep their existing revocation policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'admin_sessions' AND column_name = 'auth_method'
  ) THEN
    ALTER TABLE admin_sessions ADD COLUMN auth_method text CHECK (auth_method IN ('password','feishu'));
    ALTER TABLE admin_sessions ADD COLUMN auth_binding text;
    UPDATE admin_sessions s
       SET auth_method = CASE WHEN u.email = 'admin@local' AND u.feishu_union_id IS NULL THEN 'password' ELSE 'feishu' END,
           auth_binding = 'pre-membership-migration'
      FROM admin_users u WHERE u.id = s.user_id AND s.expires_at > now();
  END IF;
END $$;
