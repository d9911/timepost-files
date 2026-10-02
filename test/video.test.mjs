import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FileService, maxVideoBytes } from '../src/service.mjs';

test('проверяет настоящее MP4, сохраняет видео и отклоняет подмену MIME до записи', async () => {
  const rows = new Map();
  const repository = {
    insert: async (file) => rows.set(file.id, { ...file, status: 'pending' }),
    setStatus: async (id, status) => {
      rows.get(id).status = status;
    },
    get: async (id) => rows.get(id),
  };
  const saved = new Map();
  const storage = { provider: 'simulator', upload: async (id, bytes) => saved.set(id, bytes) };
  const service = new FileService(repository, storage, async () => {});
  const bytes = await readFile(new URL('./fixtures/video.mp4', import.meta.url));
  const file = await service.upload('1', '3', bytes, 'video/mp4', 'clip.mp4');
  assert.equal(file.mimeType, 'video/mp4');
  assert.equal(file.width, 64);
  assert.equal(file.height, 48);
  assert.equal(file.durationSeconds, 0.4);
  assert.deepEqual(saved.get(file.id), bytes);
  assert.equal((await service.metadata(file.id, '1')).durationSeconds, 0.4);
  await assert.rejects(
    service.upload('1', '3', Buffer.from('<html>'), 'video/mp4'),
    (error) => error.code === 'INVALID_VIDEO',
  );
  await assert.rejects(
    service.upload('1', '3', bytes, 'video/webm'),
    (error) => error.code === 'INVALID_VIDEO',
  );
  await assert.rejects(
    service.upload('1', '3', Buffer.alloc(maxVideoBytes + 1), 'video/mp4'),
    (error) => error.code === 'FILE_TOO_LARGE',
  );
  assert.equal(rows.size, 1);
  const webm = await readFile(new URL('./fixtures/video.webm', import.meta.url));
  const second = await service.upload('1', '3', webm, 'video/webm', 'clip.webm');
  assert.equal(second.mimeType, 'video/webm');
  assert.equal(second.width, 64);
  assert.equal(second.height, 48);
  assert.equal(second.durationSeconds, 0.4);
  assert.deepEqual(saved.get(second.id), webm);
});
