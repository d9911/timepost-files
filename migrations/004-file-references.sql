ALTER TABLE stored_files ADD COLUMN reference_managed boolean NOT NULL DEFAULT false;
CREATE TABLE file_references (
  project_id text NOT NULL,
  reference_id text NOT NULL,
  file_id uuid NOT NULL REFERENCES stored_files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, reference_id, file_id)
);
CREATE INDEX file_references_file_index ON file_references(file_id);
