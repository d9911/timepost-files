import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresFileRepository } from '../src/modules/files/infrastructure/persistence/postgres-file-repository.js';
import { PostgresStoragePolicies } from '../src/modules/files/infrastructure/persistence/postgres-storage-policies.js';
import type { FileRecord } from '../src/modules/files/domain/file.js';

test(
  'PostgreSQL: лимиты сериализуют параллельные загрузки; очистка повторно проверяет ссылки',
  { skip: !process.env.FILES_TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.FILES_TEST_DATABASE_URL;
    const root = new pg.Pool({ connectionString });
    const schema = `storage_test_${randomUUID().replaceAll('-', '')}`;
    await root.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      const files = new PostgresFileRepository(pool, new URL('../../migrations/', import.meta.url));
      await files.initialize();
      const policies = new PostgresStoragePolicies(pool);
      const settings = {
        planId: 'start' as const,
        maxFileBytes: 10,
        quotaBytes: 10,
        concurrentUploads: 1,
        retentionDays: null,
        uploadsEnabled: true,
        retentionEnabled: false,
      };
      await policies.updateUser('1', '2', settings);
      const make = (): FileRecord => ({
        id: randomUUID(),
        ownerId: '2',
        projectId: '3',
        mimeType: 'image/png',
        sizeBytes: 6,
        width: 1,
        height: 1,
        provider: 'simulator',
      });
      const first = make();
      await files.insert(first);
      await assert.rejects(files.insert({ ...make(), sizeBytes: 1 }), { code: 'UPLOAD_BUSY' });
      await files.setStatus(first.id, 'ready');
      assert.equal(typeof (await files.get(first.id))!.sizeBytes, 'number');
      await assert.rejects(files.insert(make()), { code: 'STORAGE_QUOTA_EXCEEDED' });
      await policies.updateUser('1', '2', { ...settings, quotaBytes: 20, concurrentUploads: 4 });
      const races = await Promise.allSettled([
        files.insert(make()),
        files.insert(make()),
        files.insert(make()),
      ]);
      assert.equal(races.filter((result) => result.status === 'fulfilled').length, 2);
      await policies.updateUser('1', '2', { ...settings, uploadsEnabled: false });
      await assert.rejects(files.insert({ ...make(), sizeBytes: 1 }), { code: 'FILE_FORBIDDEN' });
      const preview = await policies.cleanupPreview('1', '2', 'simulator');
      assert.equal(preview.count, 1);
      await files.replaceReferences({
        projectId: '3',
        referenceId: 'post-1',
        fileIds: [first.id],
        cleanupRemoved: false,
      });
      const queue = await policies.cleanup('1', '2', preview.previewId);
      assert.equal(queue.count, 0);
      assert.equal((await files.get(first.id))!.status, 'ready');
      assert.equal((await policies.cleanupPreview('1', '2', 'simulator')).count, 0);
      await files.replaceReferences({
        projectId: '3',
        referenceId: 'post-1',
        fileIds: [],
        cleanupRemoved: false,
      });
      const next = await policies.cleanupPreview('1', '2', 'simulator');
      const deleted = await policies.cleanup('1', '2', next.previewId);
      assert.equal(deleted.count, 1);
      assert.equal((await files.get(first.id))!.status, 'deleting');
      assert.equal((await policies.cleanup('1', '2', next.previewId)).replayed, true);
      const job = await files.claimDelete('simulator');
      assert.equal(job!.fileId, first.id);
      await files.completeDelete(job!);
      assert.equal((await files.get(first.id))!.status, 'deleted');
    } finally {
      await pool.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  },
);
