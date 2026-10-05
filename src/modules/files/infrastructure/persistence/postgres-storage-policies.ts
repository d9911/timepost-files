import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { StoragePoliciesPort } from '../../application/ports/storage-policies.js';
import type { StoragePolicy, StorageUserSettings } from '../../domain/storage-policy.js';
import { FileError } from '../../../../shared/application/file-error.js';
interface SocialNetworkUsage {
  socialNetwork: string;
  usedBytes: string;
  reservedBytes: string;
  fileCount: number;
  userCount?: number;
}
interface StorageUserUsage {
  userId: string;
  usedBytes: string;
  reservedBytes: string;
  fileCount: number;
  imageCount: number;
  videoCount: number;
  oldestCreatedAt: Date | null;
}

export class PostgresStoragePolicies implements StoragePoliciesPort {
  constructor(private readonly pool: Pool) {}
  async policy(userId: string, client: Pool | PoolClient = this.pool): Promise<StoragePolicy> {
    const { rows } = await client.query(
      `SELECT p.id AS "planId", COALESCE(u.max_file_bytes,p.max_file_bytes)::float8 AS "maxFileBytes", COALESCE(u.quota_bytes,p.quota_bytes)::float8 AS "quotaBytes", COALESCE(u.concurrent_uploads,p.concurrent_uploads) AS "concurrentUploads", COALESCE(u.retention_days,p.retention_days) AS "retentionDays", COALESCE(u.uploads_enabled,true) AS "uploadsEnabled", COALESCE(u.retention_enabled,p.retention_enabled) AS "retentionEnabled", p.version FROM storage_plans p LEFT JOIN storage_user_settings u ON u.user_id=$1 WHERE p.id=COALESCE(u.plan_id,'start')`,
      [userId],
    );
    return rows[0] as StoragePolicy;
  }
  async plans(): Promise<StoragePolicy[]> {
    const { rows } = await this.pool.query(
      `SELECT id AS "planId", max_file_bytes::float8 AS "maxFileBytes", quota_bytes::float8 AS "quotaBytes", concurrent_uploads AS "concurrentUploads", retention_days AS "retentionDays", true AS "uploadsEnabled", retention_enabled AS "retentionEnabled", version FROM storage_plans ORDER BY max_file_bytes`,
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
        retentionEnabled: true,
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
        `UPDATE storage_plans SET max_file_bytes=$2,quota_bytes=$3,concurrent_uploads=$4,retention_days=$5,retention_enabled=$6,version=version+1 WHERE id=$1`,
        [
          id,
          p.maxFileBytes,
          p.quotaBytes,
          p.concurrentUploads,
          p.retentionDays,
          p.retentionEnabled,
        ],
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
  async enqueueRetention(provider: string): Promise<number> {
    const candidates = await this.pool.query<{ id: string; owner_id: string }>(
      `SELECT f.id,f.owner_id FROM stored_files f
       LEFT JOIN storage_user_settings u ON u.user_id=f.owner_id
       JOIN storage_plans p ON p.id=COALESCE(u.plan_id,'start')
       WHERE f.provider=$1 AND f.status='ready' AND f.reference_tracking_complete
         AND COALESCE(u.retention_enabled,p.retention_enabled)
         AND f.created_at < now()-make_interval(days=>COALESCE(u.retention_days,p.retention_days))
         AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=f.id)
       ORDER BY f.owner_id,f.id LIMIT 1000`,
      [provider],
    );
    let count = 0;
    for (const owner of [...new Set(candidates.rows.map((row) => row.owner_id))]) {
      count += await this.transaction(async (client) => {
        // Shared profile locks precede the owner lock, including admin profile updates.
        await client.query('SELECT id FROM storage_plans ORDER BY id FOR SHARE');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `files-upload:${owner}`,
        ]);
        const policy = await this.policy(owner, client);
        if (!policy.retentionEnabled) return 0;
        const ids = candidates.rows.filter((row) => row.owner_id === owner).map((row) => row.id);
        await client.query(
          'SELECT id FROM stored_files WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [ids],
        );
        // Recheck references in a fresh statement after the file locks are acquired.
        const changed = await client.query(
          `WITH changed AS (UPDATE stored_files f SET status='deleting'
           WHERE f.id=ANY($1::uuid[]) AND f.owner_id=$2 AND f.provider=$3
             AND f.status='ready' AND f.reference_tracking_complete
             AND f.created_at < now()-make_interval(days=>$4::int)
             AND NOT EXISTS(SELECT 1 FROM file_references r WHERE r.file_id=f.id)
           RETURNING id), queued AS (INSERT INTO file_delete_jobs(file_id)
           SELECT id FROM changed ON CONFLICT(file_id) DO UPDATE
           SET status='pending',available_at=now(),attempts=0,lease_id=NULL
           WHERE file_delete_jobs.status='failed') SELECT id FROM changed`,
          [ids, owner, provider, policy.retentionDays],
        );
        return changed.rowCount ?? 0;
      });
    }
    return count;
  }
  async summary(provider: string) {
    const { rows } = await this.pool.query<{
      usedBytes: string;
      fileCount: number;
      userCount: number;
      reservedBytes: string;
      pendingCount: number;
      deletingCount: number;
    }>(
      `SELECT COALESCE(sum(size_bytes) FILTER(WHERE status IN ('ready','deleting')),0)::text AS "usedBytes", count(*) FILTER(WHERE status IN ('ready','deleting'))::int AS "fileCount", count(DISTINCT owner_id) FILTER(WHERE status IN ('ready','deleting'))::int AS "userCount", COALESCE(sum(size_bytes) FILTER(WHERE status='pending'),0)::text AS "reservedBytes", count(*) FILTER(WHERE status='pending')::int AS "pendingCount",count(*) FILTER(WHERE status='deleting')::int AS "deletingCount" FROM stored_files WHERE provider=$1`,
      [provider],
    );
    const groups = await this.pool.query<SocialNetworkUsage & { userId: string }>(
      `SELECT COALESCE(social_network,'unknown') AS "socialNetwork",
       COALESCE(sum(size_bytes) FILTER(WHERE status IN ('ready','deleting')),0)::text AS "usedBytes",
       count(*) FILTER(WHERE status IN ('ready','deleting'))::int AS "fileCount",
       count(DISTINCT owner_id) FILTER(WHERE status IN ('ready','deleting'))::int AS "userCount",
       COALESCE(sum(size_bytes) FILTER(WHERE status='pending'),0)::text AS "reservedBytes"
       FROM stored_files WHERE provider=$1 AND status IN ('pending','ready','deleting')
       GROUP BY social_network ORDER BY social_network NULLS LAST`,
      [provider],
    );
    return {
      ...rows[0],
      bySocialNetwork: groups.rows,
      provider,
      measuredAt: new Date().toISOString(),
      scope: 'managed-files',
      physicalBucketBytes: null,
    };
  }
  async users(provider: string, cursor: string, userId: string) {
    const { rows } = await this.pool.query<StorageUserUsage>(
      `WITH owners AS (SELECT owner_id AS id FROM stored_files WHERE provider=$1 UNION SELECT user_id FROM storage_user_settings) SELECT o.id AS "userId", COALESCE(sum(f.size_bytes) FILTER(WHERE f.status IN ('ready','deleting')),0)::text AS "usedBytes", count(f.id) FILTER(WHERE f.status IN ('ready','deleting'))::int AS "fileCount", count(f.id) FILTER(WHERE f.mime_type LIKE 'image/%' AND f.status IN ('ready','deleting'))::int AS "imageCount",count(f.id) FILTER(WHERE f.mime_type LIKE 'video/%' AND f.status IN ('ready','deleting'))::int AS "videoCount", min(f.created_at) FILTER(WHERE f.status IN ('ready','deleting')) AS "oldestCreatedAt", COALESCE(sum(f.size_bytes) FILTER(WHERE f.status='pending'),0)::text AS "reservedBytes" FROM owners o LEFT JOIN stored_files f ON f.owner_id=o.id AND f.provider=$1 WHERE o.id>$2 AND ($3='' OR o.id=$3) GROUP BY o.id ORDER BY o.id LIMIT 51`,
      [provider, cursor, userId],
    );
    const items = rows.slice(0, 50);
    const groups = await this.pool.query<SocialNetworkUsage & { userId: string }>(
      `SELECT owner_id AS "userId", COALESCE(social_network,'unknown') AS "socialNetwork",
       COALESCE(sum(size_bytes) FILTER(WHERE status IN ('ready','deleting')),0)::text AS "usedBytes",
       count(*) FILTER(WHERE status IN ('ready','deleting'))::int AS "fileCount",
       COALESCE(sum(size_bytes) FILTER(WHERE status='pending'),0)::text AS "reservedBytes"
       FROM stored_files WHERE provider=$1 AND owner_id=ANY($2::text[])
         AND status IN ('pending','ready','deleting')
       GROUP BY owner_id,social_network ORDER BY owner_id,social_network NULLS LAST`,
      [provider, items.map((row) => row.userId)],
    );
    return {
      items: items.map((row) => ({
        ...row,
        bySocialNetwork: groups.rows
          .filter((group) => group.userId === row.userId)
          .map((group) => ({
            socialNetwork: group.socialNetwork,
            usedBytes: group.usedBytes,
            reservedBytes: group.reservedBytes,
            fileCount: group.fileCount,
          })),
      })),
      nextCursor: rows.length > 50 ? rows[49]!.userId : null,
    };
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
