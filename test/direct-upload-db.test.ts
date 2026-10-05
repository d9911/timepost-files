import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresFileRepository } from '../src/modules/files/infrastructure/persistence/postgres-file-repository.js';
import { processDelete } from '../src/modules/files/application/process-delete.js';
import type { FileRecord } from '../src/modules/files/domain/file.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test(
  'PostgreSQL direct uploads persist objects, serialize completion, rollback failures and queue safe deletion',
  { skip: !process.env.FILES_TEST_DATABASE_URL },
  async () => {
    const connectionString = process.env.FILES_TEST_DATABASE_URL;
    const root = new pg.Pool({ connectionString });
    const schema = `direct_test_${randomUUID().replaceAll('-', '')}`;
    await root.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      const repo = new PostgresFileRepository(pool, new URL('../../migrations/', import.meta.url));
      await repo.initialize();
      const make = (ownerId = '1'): FileRecord => {
        const id = randomUUID();
        return {
          id,
          ownerId,
          projectId: '2',
          mimeType: 'image/png',
          sizeBytes: 42,
          width: null,
          height: null,
          fileName: 'original.png',
          provider: 'yandex-object',
          bucket: 'test-media',
          incomingKey: `incoming/${ownerId}/2/${id}/original.png`,
          objectKey: `media/${ownerId}/2/${id}/original.png`,
          uploadExpiresAt: new Date(Date.now() + 60_000),
          socialNetwork: 'instagram',
        };
      };
      const file = make();
      await repo.insert(file);
      await repo.setMultipart(file.id, 's3-upload');
      const stored = (await repo.get(file.id))!;
      for (const field of ['bucket', 'incomingKey', 'objectKey', 'socialNetwork'] as const)
        assert.equal(stored[field], file[field]);
      assert.equal(stored.multipartUploadId, 's3-upload');
      assert.equal(
        new Date(stored.uploadExpiresAt!).getTime(),
        new Date(file.uploadExpiresAt!).getTime(),
      );
      assert.equal(stored.status, 'pending');
      const metadata = { mimeType: 'image/png', width: 1, height: 1, sha256: 'a'.repeat(64) };
      await assert.rejects(
        repo.completeUpload(file.id, '9', async () => {
          throw new Error('foreign work must not run');
        }),
        { code: 'FILE_NOT_FOUND' },
      );
      const entered = gate();
      const release = gate();
      let workCount = 0;
      const first = repo.completeUpload(file.id, '1', async () => {
        workCount++;
        entered.release();
        await release.promise;
        return metadata;
      });
      await entered.promise;
      const second = repo.completeUpload(file.id, '1', async () => {
        workCount++;
        return metadata;
      });
      release.release();
      const results = await Promise.all([first, second]);
      assert.equal(workCount, 1);
      assert.ok(results.every((record) => record.status === 'ready'));
      assert.equal(results[0]!.sha256, metadata.sha256);
      // Failure cannot commit partial metadata or ready status.
      const failed = make('3');
      await repo.insert(failed);
      await assert.rejects(
        repo.completeUpload(failed.id, '3', async () => {
          throw new Error('invalid image');
        }),
        /invalid image/,
      );
      assert.equal((await repo.get(failed.id))!.status, 'pending');
      assert.equal((await repo.get(failed.id))!.sha256, null);
      const expired = make('4');
      expired.uploadExpiresAt = new Date(Date.now() - 1);
      await repo.insert(expired);
      await assert.rejects(
        repo.completeUpload(expired.id, '4', async () => metadata),
        { code: 'FILE_NOT_FOUND' },
      );
      // Cancellation obtains the same row lock; successful completion keeps ready.
      const concurrent = make('5');
      await repo.insert(concurrent);
      const validating = gate();
      const validated = gate();
      const completion = repo.completeUpload(concurrent.id, '5', async () => {
        validating.release();
        await validated.promise;
        return metadata;
      });
      await validating.promise;
      const cancellation = repo.cancelUpload(concurrent.id, '5');
      validated.release();
      await Promise.all([completion, cancellation]);
      assert.equal((await repo.get(concurrent.id))!.status, 'ready');
      assert.equal(await repo.deleteStatus(concurrent.id), undefined);
      const cancelled = make('6');
      await repo.insert(cancelled);
      await repo.setMultipart(cancelled.id, 'cancelled-upload');
      await repo.cancelUpload(cancelled.id, '6');
      await assert.rejects(
        repo.completeUpload(cancelled.id, '6', async () => metadata),
        { code: 'FILE_NOT_FOUND' },
      );
      await assert.rejects(repo.setMultipart(cancelled.id, 'late-upload'), {
        code: 'FILE_NOT_FOUND',
      });
      const job = (await repo.claimDelete('yandex-object'))!;
      assert.equal(job.fileId, cancelled.id);
      assert.equal(job.bucket, cancelled.bucket);
      assert.equal(job.incomingKey, cancelled.incomingKey);
      assert.equal(job.objectKey, cancelled.objectKey);
      assert.equal(job.multipartUploadId, 'cancelled-upload');
      await repo.retryDelete(job);
      await pool.query('UPDATE file_delete_jobs SET available_at=now() WHERE file_id=$1', [
        cancelled.id,
      ]);
      const calls: string[] = [];
      const storage = {
        provider: 'yandex-object' as const,
        bucket: 'test-media',
        async abortMultipart(key: string, uploadId: string) {
          assert.equal(key, cancelled.incomingKey);
          assert.equal(uploadId, 'cancelled-upload');
          calls.push('abort');
          const error = new Error('already completed');
          error.name = 'NoSuchUpload';
          throw error;
        },
        async deleteObject(key: string) {
          assert.equal(key, cancelled.incomingKey);
          calls.push('incoming');
        },
        async delete(id: string, key?: string) {
          assert.equal(id, cancelled.id);
          assert.equal(key, cancelled.objectKey);
          calls.push('media');
        },
      };
      assert.equal(await processDelete(repo, storage), true);
      assert.deepEqual(calls, ['abort', 'incoming', 'media']);
      assert.equal((await repo.get(cancelled.id))!.status, 'deleted');
      assert.equal((await repo.deleteStatus(cancelled.id))!.status, 'done');
      // A bucket switch cannot delete a key from the new bucket.
      const switched = make('7');
      switched.bucket = 'old-media';
      await repo.insert(switched);
      await repo.cancelUpload(switched.id, '7');
      calls.length = 0;
      assert.equal(await processDelete(repo, storage), true);
      assert.deepEqual(calls, []);
      assert.equal((await repo.deleteStatus(switched.id))!.status, 'pending');
    } finally {
      await pool.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  },
);
