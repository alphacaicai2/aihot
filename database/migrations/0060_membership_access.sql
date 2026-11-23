CREATE TABLE membership_grants (
  email text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Each key belongs to exactly one authenticated account. Only a digest is stored.
CREATE TABLE membership_agent_tokens (
  token_hash text PRIMARY KEY,
  reader_subject text UNIQUE REFERENCES readers (google_subject) ON DELETE CASCADE,
  admin_user_id bigint UNIQUE REFERENCES admin_users (id) ON DELETE CASCADE,
  admin_method text,
  admin_binding text,
  CHECK ((reader_subject IS NOT NULL AND admin_user_id IS NULL AND admin_method IS NULL AND admin_binding IS NULL)
      OR (reader_subject IS NULL AND admin_user_id IS NOT NULL AND admin_method IS NOT NULL
          AND admin_method IN ('password', 'feishu') AND admin_binding IS NOT NULL))
);

-- An email grant can have only one current, verified Google account owner.
CREATE TABLE reader_email_bindings (
  email text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email <> ''),
  google_subject text NOT NULL UNIQUE REFERENCES readers(google_subject) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('google','confirmation'))
);

-- Legacy Google sessions recorded email_verified but not hd. Gmail addresses
-- have Google as their authority. Ambiguous or third-party addresses need new proof.
INSERT INTO reader_email_bindings(email,google_subject,method)
SELECT lower(btrim(email)),min(google_subject),'google' FROM readers
WHERE lower(btrim(email)) LIKE '%@gmail.com'
GROUP BY lower(btrim(email)) HAVING count(*)=1;

CREATE TABLE membership_confirmation_codes (
  email text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email <> ''),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
