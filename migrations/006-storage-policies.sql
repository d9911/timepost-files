ALTER TABLE stored_files ALTER COLUMN size_bytes TYPE bigint;
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS bucket text;
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS object_key text;
CREATE TABLE storage_plans (
  id text PRIMARY KEY CHECK(id IN ('start','pro','business')),
  max_file_bytes bigint NOT NULL CHECK(max_file_bytes BETWEEN 1 AND 10000000000),
  quota_bytes bigint CHECK(quota_bytes >= 0),
  concurrent_uploads integer NOT NULL DEFAULT 4 CHECK(concurrent_uploads BETWEEN 1 AND 32),
  retention_days integer NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 1 AND 3650),
  version integer NOT NULL DEFAULT 1
);
INSERT INTO storage_plans(id,max_file_bytes) VALUES ('start',150000000),('pro',300000000),('business',10000000000);
CREATE TABLE storage_user_settings (
  user_id text PRIMARY KEY,
  plan_id text NOT NULL DEFAULT 'start' REFERENCES storage_plans(id),
  max_file_bytes bigint CHECK(max_file_bytes BETWEEN 1 AND 10000000000),
  quota_bytes bigint CHECK(quota_bytes >= 0),
  concurrent_uploads integer CHECK(concurrent_uploads BETWEEN 1 AND 32),
  retention_days integer CHECK(retention_days BETWEEN 1 AND 3650),
  uploads_enabled boolean NOT NULL DEFAULT true,
  retention_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_admin_audit (
  id bigserial PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL,
  user_id text, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_cleanup_previews (
  id uuid PRIMARY KEY, user_id text NOT NULL, actor_id text NOT NULL,
  provider text NOT NULL, file_ids uuid[] NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  executed_at timestamptz
);
