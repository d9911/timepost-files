import { FileError } from '../../../../shared/application/file-error.js';
import type { FileReferenceChange } from '../../application/ports/file-references.js';
import type {
  FileRepositoryPort,
  DeleteRepositoryPort,
} from '../../application/ports/file-repository.js';
import { Pool, type PoolClient } from 'pg';
import type {
  FileRecord,
  FileStatus,
  StorageProvider,
  DeleteJob,
  DeleteStatus,
} from '../../domain/file.js';
import { readFile } from 'node:fs/promises';
import { PostgresStoragePolicies } from './postgres-storage-policies.js';
import type { MediaMetadata } from '../../application/ports/media-inspector.js';

export class PostgresFileRepository implements FileRepositoryPort, DeleteRepositoryPort {
  constructor(
    public readonly pool: Pool | PoolClient,
    private readonly migrationsDirectory: URL,
  ) {}

  async initialize() {
    if (!(this.pool instanceof Pool)) throw new Error('Для миграций требуется Pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(305001)');
      await client.query(
        'CREATE TABLE IF NOT EXISTS file_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of [
        '001-files.sql',
        '002-object-metadata-and-jobs.sql',
        '003-video-duration.sql',
        '004-file-references.sql',
        '005-reference-tracking-complete.sql',
        '006-storage-policies.sql',
        '007-direct-uploads.sql',
        '008-storage-retention.sql',
      ]) {
        const existing = await client.query(
          'SELECT name FROM file_schema_migrations WHERE name=$1',
          [name],
        );
        if (existing.rowCount) continue;
        await client.query(await readFile(new URL(name, this.migrationsDirectory), 'utf8'));
        await client.query('INSERT INTO file_schema_migrations(name) VALUES($1)', [name]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async insert(file: FileRecord) {
    if (!(this.pool instanceof Pool)) throw new Error('Для загрузки требуется Pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM storage_plans ORDER BY id FOR SHARE');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `files-upload:${file.ownerId}`,
      ]);
      const policy = await new PostgresStoragePolicies(this.pool).policy(file.ownerId, client);
      if (!policy.uploadsEnabled)
        throw new FileError('FILE_FORBIDDEN', 'Загрузки пользователя отключены');
      if (file.sizeBytes > policy.maxFileBytes)
        throw new FileError('FILE_TOO_LARGE', 'Превышен лимит профиля хранения');
      const usage = await client.query(
        `SELECT COALESCE(sum(size_bytes),0)::text AS bytes, count(*) FILTER(WHERE status='pending')::int AS pending FROM stored_files WHERE owner_id=$1 AND status IN ('pending','ready','deleting')`,
        [file.ownerId],
      );
      if (
        policy.quotaBytes !== null &&
        BigInt(usage.rows[0].bytes) + BigInt(file.sizeBytes) > BigInt(policy.quotaBytes)
      )
        throw new FileError('STORAGE_QUOTA_EXCEEDED', 'Недостаточно доступного места');
      if (usage.rows[0].pending >= policy.concurrentUploads)
        throw new FileError('UPLOAD_BUSY', 'Достигнут лимит одновременных загрузок');
      await client.query(
        'INSERT INTO stored_files (id,owner_id,project_id,mime_type,size_bytes,width,height,status,file_name,sha256,provider,duration_seconds,reference_tracking_complete,bucket,object_key,incoming_key,multipart_upload_id,upload_expires_at,social_network) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$17,$18)',
        [
          file.id,
          file.ownerId,
          file.projectId,
          file.mimeType,
          file.sizeBytes,
          file.width,
          file.height,
          'pending',
          file.fileName ?? null,
          file.sha256 ?? null,
          file.provider ?? 'yandex',
          file.durationSeconds ?? null,
          file.bucket ?? null,
          file.objectKey ?? null,
          file.incomingKey ?? null,
          file.multipartUploadId ?? null,
          file.uploadExpiresAt ?? null,
          file.socialNetwork ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async setStatus(id: string, status: FileStatus) {
    await this.pool.query('UPDATE stored_files SET status=$2 WHERE id=$1', [id, status]);
  }
  async setMultipart(id: string, uploadId: string) {
    const result = await this.pool.query(
      "UPDATE stored_files SET multipart_upload_id=$2 WHERE id=$1 AND status='pending'",
      [id, uploadId],
    );
    if (result.rowCount !== 1) throw new FileError('FILE_NOT_FOUND', 'Загрузка отменена');
  }
  async completeUpload(
    id: string,
    ownerId: string,
    work: (file: FileRecord) => Promise<MediaMetadata & { sha256: string }>,
  ) {
    if (!(this.pool instanceof Pool)) throw new Error('Для завершения загрузки требуется Pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM stored_files WHERE id=$1 FOR UPDATE', [id]);
      const repository = new PostgresFileRepository(client, this.migrationsDirectory);
      const file = await repository.get(id);
      if (!file || file.ownerId !== ownerId)
        throw new FileError('FILE_NOT_FOUND', 'Загрузка не найдена');
      if (file.status === 'ready') {
        await client.query('COMMIT');
        return file;
      }
      if (
        file.status !== 'pending' ||
        !file.uploadExpiresAt ||
        new Date(file.uploadExpiresAt).getTime() <= Date.now()
      )
        throw new FileError('FILE_NOT_FOUND', 'Загрузка истекла или отменена');
      const metadata = await work(file);
      await client.query(
        "UPDATE stored_files SET status='ready',mime_type=$2,width=$3,height=$4,duration_seconds=$5,sha256=$6 WHERE id=$1",
        [
          id,
          metadata.mimeType,
          metadata.width,
          metadata.height,
          metadata.durationSeconds ?? null,
          metadata.sha256,
        ],
      );
      const ready = await repository.get(id);
      await client.query('COMMIT');
      return ready!;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async cancelUpload(id: string, ownerId: string) {
    await this.pool.query(
      `WITH cancelled AS (UPDATE stored_files SET status='deleting' WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING id) INSERT INTO file_delete_jobs(file_id) SELECT id FROM cancelled ON CONFLICT DO NOTHING`,
      [id, ownerId],
    );
    const file = await this.get(id);
    return file?.ownerId === ownerId ? file.status : undefined;
  }
  async remove(id: string) {
    await this.pool.query('DELETE FROM stored_files WHERE id=$1', [id]);
  }
  async list(projectId: string, limit: number, cursor: string | null, provider: StorageProvider) {
    const { rows } = await this.pool.query<FileRecord>(
      `SELECT id,owner_id AS "ownerId",status,project_id AS "projectId",mime_type AS "mimeType",size_bytes AS "sizeBytes",width,height,duration_seconds AS "durationSeconds",file_name AS "fileName",sha256,provider,created_at AS "createdAt",bucket,object_key AS "objectKey",incoming_key AS "incomingKey",multipart_upload_id AS "multipartUploadId",upload_expires_at AS "uploadExpiresAt",social_network AS "socialNetwork" FROM stored_files WHERE project_id=$1 AND status='ready' AND provider=$4 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $2`,
      [projectId, limit, cursor, provider],
    );
    return rows.map((row) => ({ ...row, sizeBytes: Number(row.sizeBytes) }));
  }
  async queueDelete(id: string, requireManaged = false) {
    if (!(this.pool instanceof Pool)) throw new Error('Для удаления требуется Pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Отдельный statement после блокировки видит ссылки, завершённые конкурентным запросом.
      await client.query('SELECT id FROM stored_files WHERE id=$1 FOR UPDATE', [id]);
      const { rows } = await client.query<{ id: string }>(
        `WITH changed AS (UPDATE stored_files f SET status='deleting'
          WHERE f.id=$1 AND f.status IN ('ready','deleting')
          AND (NOT $2::boolean OR f.reference_tracking_complete)
          AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=f.id) RETURNING f.id),
        queued AS (INSERT INTO file_delete_jobs(file_id) SELECT id FROM changed
          ON CONFLICT(file_id) DO UPDATE SET status='pending',attempts=0,lease_id=NULL,available_at=now()
          WHERE file_delete_jobs.status='failed') SELECT id FROM changed`,
        [id, requireManaged],
      );
      if (!rows.length)
        throw new FileError('FILE_IN_USE', 'Файл используется или не прошёл учёт ссылок');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async replaceReferences(change: FileReferenceChange) {
    if (!(this.pool instanceof Pool)) throw new Error('Для ссылок требуется Pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Блокировка владельца сериализует повторные запросы, блокировка файлов — удаление.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${change.projectId}:${change.referenceId}`,
      ]);
      const previous = await client.query<{ file_id: string }>(
        'SELECT file_id FROM file_references WHERE project_id=$1 AND reference_id=$2',
        [change.projectId, change.referenceId],
      );
      const ids = [
        ...new Set([...change.fileIds, ...previous.rows.map((row) => row.file_id)]),
      ].sort();
      const locked = await client.query<{ id: string; project_id: string; status: string }>(
        'SELECT id,project_id,status FROM stored_files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ids],
      );
      for (const id of change.fileIds) {
        const file = locked.rows.find((row) => row.id === id);
        if (!file || file.project_id !== change.projectId || file.status !== 'ready')
          throw new FileError('FILE_NOT_FOUND', 'Файл недоступен для привязки к посту');
      }
      await client.query(
        'UPDATE stored_files SET reference_managed=true WHERE id=ANY($1::uuid[])',
        [change.fileIds],
      );
      await client.query('DELETE FROM file_references WHERE project_id=$1 AND reference_id=$2', [
        change.projectId,
        change.referenceId,
      ]);
      for (const id of change.fileIds)
        await client.query(
          'INSERT INTO file_references(project_id,reference_id,file_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [change.projectId, change.referenceId, id],
        );
      if (change.cleanupRemoved) {
        const removed = previous.rows
          .map((row) => row.file_id)
          .filter((id) => !change.fileIds.includes(id));
        // Удаляются только ранее зарегистрированные файлы, утратившие последнюю ссылку.
        await client.query(
          `WITH changed AS (
          UPDATE stored_files f SET status='deleting' WHERE id=ANY($1::uuid[])
          AND status='ready' AND reference_tracking_complete AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=f.id)
          RETURNING id) INSERT INTO file_delete_jobs(file_id) SELECT id FROM changed ON CONFLICT DO NOTHING`,
          [removed],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async deleteStatus(id: string) {
    const { rows } = await this.pool.query<DeleteStatus>(
      'SELECT file_id AS "fileId",status,attempts FROM file_delete_jobs WHERE file_id=$1',
      [id],
    );
    return rows[0];
  }
  async enqueueAbandoned(provider: StorageProvider) {
    // pending не выдаётся клиентам: спустя сутки незавершённую загрузку можно убрать.
    await this.pool.query(
      `WITH abandoned AS (UPDATE stored_files SET status='deleting' WHERE status='pending' AND provider=$1 AND COALESCE(upload_expires_at,created_at+interval '24 hours')<now() RETURNING id) INSERT INTO file_delete_jobs(file_id) SELECT id FROM abandoned ON CONFLICT DO NOTHING`,
      [provider],
    );
  }
  async claimDelete(provider: StorageProvider) {
    const { rows } = await this.pool.query<DeleteJob>(
      `WITH next AS (
      SELECT j.file_id FROM file_delete_jobs j JOIN stored_files f ON f.id=j.file_id
      WHERE f.provider=$1 AND j.status IN ('pending','running') AND j.available_at<=now()
      ORDER BY j.available_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
    ) UPDATE file_delete_jobs j SET status='running', attempts=attempts+1, lease_id=gen_random_uuid(), available_at=now()+interval '120 seconds'
      FROM next WHERE j.file_id=next.file_id RETURNING j.file_id AS "fileId",j.attempts,j.lease_id AS "leaseId", (SELECT bucket FROM stored_files WHERE id=j.file_id) AS bucket, (SELECT object_key FROM stored_files WHERE id=j.file_id) AS "objectKey", (SELECT incoming_key FROM stored_files WHERE id=j.file_id) AS "incomingKey", (SELECT multipart_upload_id FROM stored_files WHERE id=j.file_id) AS "multipartUploadId"`,
      [provider],
    );
    return rows[0];
  }
  async completeDelete(job: DeleteJob) {
    await this.pool.query(
      `WITH completed AS (UPDATE file_delete_jobs SET status='done' WHERE file_id=$1 AND lease_id=$2 RETURNING file_id) UPDATE stored_files SET status='deleted' WHERE id IN (SELECT file_id FROM completed)`,
      [job.fileId, job.leaseId],
    );
  }
  async retryDelete(job: DeleteJob) {
    await this.pool.query(
      `UPDATE file_delete_jobs SET status=CASE WHEN attempts>=10 THEN 'failed' ELSE 'pending' END,available_at=now()+make_interval(secs => LEAST(3600,POWER(2,attempts)::integer)) WHERE file_id=$1 AND lease_id=$2`,
      [job.fileId, job.leaseId],
    );
  }
  async get(id: string) {
    const { rows } = await this.pool.query<FileRecord>(
      `SELECT id,owner_id AS "ownerId",project_id AS "projectId",mime_type AS "mimeType",
      size_bytes AS "sizeBytes",width,height,status,duration_seconds AS "durationSeconds",file_name AS "fileName",sha256,provider,created_at AS "createdAt",bucket,object_key AS "objectKey",incoming_key AS "incomingKey",multipart_upload_id AS "multipartUploadId",upload_expires_at AS "uploadExpiresAt",social_network AS "socialNetwork" FROM stored_files WHERE id=$1`,
      [id],
    );
    return rows[0] ? { ...rows[0], sizeBytes: Number(rows[0].sizeBytes) } : undefined;
  }
}
