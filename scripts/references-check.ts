import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresFileRepository } from '../src/modules/files/infrastructure/persistence/postgres-file-repository.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const repository = new PostgresFileRepository(pool, new URL('../../migrations/', import.meta.url));
const id = randomUUID();
const unusedId = randomUUID();
const projectId = String(Date.now());
const change = (referenceId: string, fileIds: string[], cleanupRemoved = false) => ({
  projectId,
  referenceId,
  fileIds,
  cleanupRemoved,
});
try {
  await repository.initialize();
  await repository.insert({
    id,
    ownerId: '1',
    projectId,
    mimeType: 'image/png',
    sizeBytes: 1,
    width: 1,
    height: 1,
    provider: 'simulator',
  });
  await repository.setStatus(id, 'ready');
  // Новая неиспользованная загрузка безопасно удаляется до первой привязки.
  await repository.insert({
    id: unusedId,
    ownerId: '1',
    projectId,
    mimeType: 'image/png',
    sizeBytes: 1,
    width: 1,
    height: 1,
    provider: 'simulator',
  });
  await repository.setStatus(unusedId, 'ready');
  await repository.queueDelete(unusedId, true);
  assert.equal((await repository.get(unusedId))?.status, 'deleting');
  await repository.replaceReferences(change('post:a', [id]));
  await repository.replaceReferences(change('post:a', [id]));
  await repository.replaceReferences(change('post:b', [id]));
  await assert.rejects(repository.queueDelete(id, true));
  await repository.replaceReferences(change('post:a', [], true));
  assert.equal((await repository.get(id))?.status, 'ready');
  await pool.query('UPDATE stored_files SET reference_tracking_complete=false WHERE id=$1', [id]);
  await repository.replaceReferences(change('post:b', [], true));
  assert.equal((await repository.get(id))?.status, 'ready');
  await assert.rejects(repository.queueDelete(id, true));
  // Только собственная тестовая запись имитирует завершённую сверку старых ссылок.
  await pool.query('UPDATE stored_files SET reference_tracking_complete=true WHERE id=$1', [id]);
  await repository.replaceReferences(change('post:b', [id]));
  await repository.replaceReferences(change('post:b', [], true));
  assert.equal((await repository.get(id))?.status, 'deleting');
  assert.equal((await repository.deleteStatus(id))?.status, 'pending');
  await assert.rejects(repository.replaceReferences(change('post:a', [id])));
  console.log(
    'PASS: PostgreSQL защищает старые и используемые файлы; последняя ссылка создаёт задание удаления.',
  );
} finally {
  // Проверка не создаёт байты: удаляются только собственные временные метаданные.
  await pool.query('DELETE FROM file_references WHERE file_id=$1', [id]);
  await pool.query('DELETE FROM file_delete_jobs WHERE file_id=ANY($1::uuid[])', [[id, unusedId]]);
  await pool.query('DELETE FROM stored_files WHERE id=ANY($1::uuid[])', [[id, unusedId]]);
  await pool.end();
}
