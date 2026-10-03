import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { StoragePoliciesPort } from '../../application/ports/storage-policies.js';
import type { StoragePolicy, StorageUserSettings } from '../../domain/storage-policy.js';
import { FileError } from '../../../../shared/application/file-error.js';

export class PostgresStoragePolicies implements StoragePoliciesPort {
  constructor(private readonly pool: Pool) {}
  async policy(userId: string, client: Pool | PoolClient = this.pool): Promise<StoragePolicy> {
    const { rows } = await client.query(
      `SELECT p.id AS "planId", COALESCE(u.max_file_bytes,p.max_file_bytes)::float8 AS "maxFileBytes", COALESCE(u.quota_bytes,p.quota_bytes)::float8 AS "quotaBytes", COALESCE(u.concurrent_uploads,p.concurrent_uploads) AS "concurrentUploads", COALESCE(u.retention_days,p.retention_days) AS "retentionDays", COALESCE(u.uploads_enabled,true) AS "uploadsEnabled", COALESCE(u.retention_enabled,false) AS "retentionEnabled", p.version FROM storage_plans p LEFT JOIN storage_user_settings u ON u.user_id=$1 WHERE p.id=COALESCE(u.plan_id,'start')`,
      [userId],
    );
    return rows[0] as StoragePolicy;
  }
  async plans(): Promise<StoragePolicy[]> {
    const { rows } = await this.pool.query(
      `SELECT id AS "planId", max_file_bytes::float8 AS "maxFileBytes", quota_bytes::float8 AS "quotaBytes", concurrent_uploads AS "concurrentUploads", retention_days AS "retentionDays", true AS "uploadsEnabled", false AS "retentionEnabled", version FROM storage_plans ORDER BY max_file_bytes`,
    );
    return rows;
  }
  async settings(userId: string): Promise<StorageUserSettings> {
    const { rows } = await this.pool.query(
      `SELECT plan_id AS "planId", max_file_bytes::float8 AS "maxFileBytes", quota_bytes::float8 AS "quotaBytes", concurrent_uploads AS "concurrentUploads", retention_days AS "retentionDays", uploads_enabled AS "uploadsEnabled", retention_enabled AS "retentionEnabled" FROM storage_user_settings WHERE user_id=$1`,
      [userId],
    );
    return (
      rows[0] ?? {
        planId: 'start',
        maxFileBytes: null,
        quotaBytes: null,
        concurrentUploads: null,
        retentionDays: null,
        uploadsEnabled: true,
        retentionEnabled: false,
      }
    );
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async updatePlan(actorId: string, id: string, p: StoragePolicy) {
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE storage_plans SET max_file_bytes=$2,quota_bytes=$3,concurrent_uploads=$4,retention_days=$5,version=version+1 WHERE id=$1`,
        [id, p.maxFileBytes, p.quotaBytes, p.concurrentUploads, p.retentionDays],
      );
      if (!result.rowCount) throw new FileError('NOT_FOUND', 'Профиль не найден');
      await client.query(
        'INSERT INTO storage_admin_audit(actor_id,action,payload) VALUES($1,$2,$3)',
        [actorId, 'plan.update', JSON.stringify({ ...p, planId: id })],
      );
    });
  }
  async updateUser(actorId: string, userId: string, s: StorageUserSettings) {
    await this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `files-upload:${userId}`,
      ]);
      await client.query(
        `INSERT INTO storage_user_settings(user_id,plan_id,max_file_bytes,quota_bytes,concurrent_uploads,retention_days,uploads_enabled,retention_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id) DO UPDATE SET plan_id=$2,max_file_bytes=$3,quota_bytes=$4,concurrent_uploads=$5,retention_days=$6,uploads_enabled=$7,retention_enabled=$8,updated_at=now()`,
        [
          userId,
          s.planId,
          s.maxFileBytes,
          s.quotaBytes,
          s.concurrentUploads,
          s.retentionDays,
          s.uploadsEnabled,
          s.retentionEnabled,
        ],
      );
      await client.query(
        'INSERT INTO storage_admin_audit(actor_id,action,user_id,payload) VALUES($1,$2,$3,$4)',
        [actorId, 'user.update', userId, JSON.stringify(s)],
      );
    });
  }
  async summary(provider: string) {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(sum(size_bytes) FILTER(WHERE status IN ('ready','deleting')),0)::text AS "usedBytes", count(*) FILTER(WHERE status IN ('ready','deleting'))::int AS "fileCount", COALESCE(sum(size_bytes) FILTER(WHERE status='pending'),0)::text AS "reservedBytes", count(*) FILTER(WHERE status='pending')::int AS "pendingCount",count(*) FILTER(WHERE status='deleting')::int AS "deletingCount" FROM stored_files WHERE provider=$1`,
      [provider],
    );
    return {
      ...rows[0],
      provider,
      measuredAt: new Date().toISOString(),
      scope: 'managed-files',
      physicalBucketBytes: null,
    };
  }
  async users(provider: string, cursor: string, userId: string) {
    const { rows } = await this.pool.query(
      `WITH owners AS (SELECT owner_id AS id FROM stored_files WHERE provider=$1 UNION SELECT user_id FROM storage_user_settings) SELECT o.id AS "userId", COALESCE(sum(f.size_bytes) FILTER(WHERE f.status IN ('ready','deleting')),0)::text AS "usedBytes", count(f.id) FILTER(WHERE f.status IN ('ready','deleting'))::int AS "fileCount", count(f.id) FILTER(WHERE f.mime_type LIKE 'image/%' AND f.status IN ('ready','deleting'))::int AS "imageCount",count(f.id) FILTER(WHERE f.mime_type LIKE 'video/%' AND f.status IN ('ready','deleting'))::int AS "videoCount", min(f.created_at) FILTER(WHERE f.status IN ('ready','deleting')) AS "oldestCreatedAt", COALESCE(sum(f.size_bytes) FILTER(WHERE f.status='pending'),0)::text AS "reservedBytes" FROM owners o LEFT JOIN stored_files f ON f.owner_id=o.id AND f.provider=$1 WHERE o.id>$2 AND ($3='' OR o.id=$3) GROUP BY o.id ORDER BY o.id LIMIT 51`,
      [provider, cursor, userId],
    );
    return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].userId : null };
  }
  async cleanupPreview(actorId: string, userId: string, provider: string) {
    const { rows } = await this.pool.query(
      `SELECT f.id, f.size_bytes::text AS size FROM stored_files f WHERE f.owner_id=$1 AND f.provider=$2 AND f.status='ready' AND f.reference_tracking_complete AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=f.id) ORDER BY f.id LIMIT 1000`,
      [userId, provider],
    );
    const previewId = randomUUID();
    await this.pool.query(
      'INSERT INTO storage_cleanup_previews(id,user_id,actor_id,provider,file_ids) VALUES($1,$2,$3,$4,$5)',
      [previewId, userId, actorId, provider, rows.map((r) => r.id)],
    );
    return {
      previewId,
      userId,
      count: rows.length,
      bytes: rows.reduce((sum, r) => sum + BigInt(r.size), 0n).toString(),
      scope: 'unreferenced',
      limit: 1000,
    };
  }
  async cleanup(actorId: string, userId: string, previewId: string) {
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM storage_cleanup_previews WHERE id=$1 AND user_id=$2 AND actor_id=$3 AND expires_at>now() FOR UPDATE`,
        [previewId, userId, actorId],
      );
      const preview = rows[0];
      if (!preview) throw new FileError('INVALID_FILE_ID', 'Подтверждение очистки истекло');
      if (preview.executed_at) return { previewId, status: 'queued', replayed: true };
      await client.query(
        'SELECT id FROM stored_files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [preview.file_ids],
      );
      const result = await client.query(
        `WITH changed AS (UPDATE stored_files f SET status='deleting' WHERE f.id=ANY($1::uuid[]) AND f.owner_id=$2 AND f.provider=$3 AND f.status='ready' AND f.reference_tracking_complete AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=f.id) RETURNING id), queued AS (INSERT INTO file_delete_jobs(file_id) SELECT id FROM changed ON CONFLICT(file_id) DO UPDATE SET status='pending',available_at=now(),attempts=0 WHERE file_delete_jobs.status='failed') SELECT id FROM changed`,
        [preview.file_ids, userId, preview.provider],
      );
      await client.query('UPDATE storage_cleanup_previews SET executed_at=now() WHERE id=$1', [
        previewId,
      ]);
      await client.query(
        'INSERT INTO storage_admin_audit(actor_id,action,user_id,payload) VALUES($1,$2,$3,$4)',
        [actorId, 'cleanup.queue', userId, JSON.stringify({ previewId, count: result.rowCount })],
      );
      return { previewId, status: 'queued', count: result.rowCount };
    });
  }
}
