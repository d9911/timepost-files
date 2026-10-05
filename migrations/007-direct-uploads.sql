ALTER TABLE stored_files
  ADD COLUMN incoming_key text,
  ADD COLUMN multipart_upload_id text,
  ADD COLUMN upload_expires_at timestamptz;
CREATE INDEX stored_files_upload_expiry ON stored_files(upload_expires_at) WHERE status='pending';
