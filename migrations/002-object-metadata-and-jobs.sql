ALTER TABLE stored_files
      ADD COLUMN IF NOT EXISTS file_name text,
      ADD COLUMN IF NOT EXISTS sha256 text,
      ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'yandex';
      ALTER TABLE stored_files ALTER COLUMN width DROP NOT NULL;
      ALTER TABLE stored_files ALTER COLUMN height DROP NOT NULL;
      ALTER TABLE stored_files DROP CONSTRAINT IF EXISTS stored_files_status_check;
      ALTER TABLE stored_files ADD CONSTRAINT stored_files_status_check CHECK (status IN ('pending','ready','deleting','deleted'));
      CREATE INDEX IF NOT EXISTS stored_files_project_index ON stored_files(project_id,id) WHERE status='ready';
      CREATE TABLE IF NOT EXISTS file_delete_jobs (
        file_id uuid PRIMARY KEY REFERENCES stored_files(id),
        attempts integer NOT NULL DEFAULT 0, lease_id uuid,
        available_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed'))
      );
