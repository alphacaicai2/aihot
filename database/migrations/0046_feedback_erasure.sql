-- Keep erasure separate from processing status; a deleted submission is never forwarded again.
ALTER TABLE feedback ADD COLUMN erased_at timestamptz;

-- Filesystem deletion follows a committed database change and survives crashes or unlink errors.
CREATE TABLE feedback_file_cleanup (
  filename text PRIMARY KEY,
  feedback_id bigint REFERENCES feedback(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_file_cleanup_feedback_idx ON feedback_file_cleanup(feedback_id);
CREATE INDEX feedback_file_cleanup_retry_idx ON feedback_file_cleanup(attempts,created_at,filename);
CREATE INDEX feedback_screenshot_idx ON feedback(screenshot_key) WHERE screenshot_key IS NOT NULL;
