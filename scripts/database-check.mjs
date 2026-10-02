import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { FileRepository } from '../src/repository.mjs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const repository = new FileRepository(client);
const id = randomUUID();
const projectId = String(Date.now());
try {
  await client.query('BEGIN');
  await repository.insert({
    id,
    ownerId: '1',
    projectId,
    mimeType: 'video/mp4',
    sizeBytes: 100,
    width: 64,
    height: 48,
    durationSeconds: 0.4,
    fileName: 'transaction.mp4',
    provider: 'simulator',
  });
  await repository.setStatus(id, 'ready');
  const file = await repository.get(id);
  assert.equal(file.durationSeconds, 0.4);
  assert.equal(file.mimeType, 'video/mp4');
  const items = await repository.list(projectId, 2, null, 'simulator');
  assert.equal(items.length, 1);
  assert.equal(items[0].durationSeconds, 0.4);
  console.log(
    'PASS: реальный SQL insert/get/list сохраняет длительность; транзакция откатывается.',
  );
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
