-- Legacy files have no reliable social-network attribution.
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS social_network text
  CHECK (social_network IS NULL OR social_network = 'instagram');
ALTER TABLE storage_plans ADD COLUMN retention_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE storage_user_settings ALTER COLUMN retention_enabled SET DEFAULT true;
-- Existing explicit retention_enabled=false choices are preserved.
CREATE INDEX stored_files_retention_idx ON stored_files(provider,created_at,owner_id)
  WHERE status='ready' AND reference_tracking_complete;
