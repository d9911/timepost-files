CREATE TABLE IF NOT EXISTS stored_files (
      id uuid PRIMARY KEY, owner_id text NOT NULL, project_id text NOT NULL,
      mime_type text NOT NULL, size_bytes integer NOT NULL, width integer NOT NULL,
      height integer NOT NULL, status text NOT NULL CHECK (status IN ('pending','ready','deleting')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
