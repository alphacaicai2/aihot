-- Durable recovery commands are looked up by operator, action and request ID, including after jobs expire.
CREATE INDEX audit_log_command_idx ON audit_log(actor,action,request_id) WHERE request_id IS NOT NULL;
