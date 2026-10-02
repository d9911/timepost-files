import { withRequestContext } from '../src/shared/infrastructure/request-context.js';
import { bytesStream } from './support/byte-stream.js';
import type { FileRecord } from '../src/modules/files/domain/file.js';
import type { FileRepositoryPort } from '../src/modules/files/application/ports/file-repository.js';
import type { StoragePort } from '../src/modules/files/application/ports/object-storage.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import sharp from 'sharp';

import { FileError } from '../src/shared/application/file-error.js';
import { createHandler } from '../src/modules/files/presentation/http/file-handler.js';
import { createFileService } from '../src/app/create-file-service.js';

test('HTTP: фото сохраняется, читается с сессией и недоступно постороннему', async (context) => {
  const rows = new Map<string, FileRecord>();
  const bytesById = new Map<string, Buffer>();
  const repository: FileRepositoryPort = {
    list: async () => [...rows.values()],
    queueDelete: async () => {},
    deleteStatus: async () => undefined,
    insert: async (file) => {
      rows.set(file.id, { ...file, status: 'pending' });
    },
    setStatus: async (id, status) => {
      rows.get(id)!.status = status;
    },
    get: async (id) => rows.get(id),
  };
  const storage: StoragePort = {
    ready: async () => {},
    delete: async () => {},
    upload: async (id, bytes) => {
      bytesById.set(id, Buffer.from(bytes));
    },
    download: async (id) => bytesStream(bytesById.get(id)!),
  };
  const service = createFileService(repository, storage, async (user, project) => {
    if (user !== '1' || project !== '3') throw new FileError('PROJECT_FORBIDDEN', 'Нет доступа');
  });
  const server = createServer(
    withRequestContext(
      createHandler(
        service,
        async (header) => {
          if (!header) throw new FileError('UNAUTHORIZED', 'Нужна сессия');
          return header === 'Bearer owner' ? '1' : '2';
        },
        async () => {},
        { uiEnabled: true, staticDirectory: new URL('../public/', import.meta.url) },
      ),
    ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const ui = await fetch(origin + '/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<script type="module" src="\/app.js"><\/script>/);
  const uiCode = await fetch(origin + '/app.js');
  assert.equal(uiCode.status, 200);
  assert.match(uiCode.headers.get('content-type') ?? '', /javascript/);

  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  assert.equal(
    (
      await fetch(`${origin}/api/v1/files?projectId=3`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: bytes,
      })
    ).status,
    401,
  );
  const saved = await fetch(`${origin}/api/v1/files?projectId=3`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', Authorization: 'Bearer owner' },
    body: bytes,
  });
  assert.equal(saved.status, 201);
  const { data } = await saved.json();
  const content = `${origin}/api/v1/files/${data.id}/content`;
  assert.equal((await fetch(content)).status, 401);
  assert.equal(
    (await fetch(content, { headers: { Authorization: 'Bearer stranger' } })).status,
    403,
  );
  const response = await fetch(content, {
    headers: { Authorization: 'Bearer owner', 'X-Request-Id': 'trace-files-test' },
  });
  assert.equal(response.headers.get('x-request-id'), 'trace-files-test');
  assert.match(response.headers.get('server-timing') ?? '', /^app;dur=/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const ranged = await fetch(content, {
    headers: { Authorization: 'Bearer owner', Range: 'bytes=2-9' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 2-9/${bytes.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(2, 10));
  assert.equal(
    (await fetch(content, { headers: { Authorization: 'Bearer owner', Range: 'bytes=99999-' } }))
      .status,
    416,
  );
  const thumbUrl = `${origin}/api/v1/files/${data.id}/thumbnail`;
  assert.equal((await fetch(thumbUrl)).status, 401);
  const thumb = await fetch(thumbUrl, { headers: { Authorization: 'Bearer owner' } });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/webp');
  const thumbMetadata = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.equal(thumbMetadata.format, 'webp');
  assert.equal(thumbMetadata.width, 2);
  const video = await readFile(new URL('./fixtures/video.mp4', import.meta.url));
  const uploaded = await fetch(`${origin}/api/v1/files?projectId=3&fileName=clip.mp4`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4', Authorization: 'Bearer owner' },
    body: video,
  });
  assert.equal(uploaded.status, 201);
  const metadata = (await uploaded.json()).data;
  assert.equal(metadata.durationSeconds, 0.4);
  const playback = await fetch(`${origin}/api/v1/files/${metadata.id}/content`, {
    headers: { Authorization: 'Bearer owner' },
  });
  assert.equal(playback.headers.get('content-type'), 'video/mp4');
  assert.equal(playback.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), video);
});
