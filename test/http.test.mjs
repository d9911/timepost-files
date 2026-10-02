import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import sharp from 'sharp';

import { FileError } from '../src/errors.mjs';
import { createHandler } from '../src/handler.mjs';
import { FileService } from '../src/service.mjs';

test('HTTP: фото сохраняется, читается с сессией и недоступно постороннему', async (context) => {
  const rows = new Map();
  const bytesById = new Map();
  const repository = {
    insert: async (file) => rows.set(file.id, { ...file, status: 'pending' }),
    setStatus: async (id, status) => {
      rows.get(id).status = status;
    },
    get: async (id) => rows.get(id),
  };
  const storage = {
    upload: async (id, bytes) => bytesById.set(id, bytes),
    download: async (id) => new Response(bytesById.get(id)),
  };
  const service = new FileService(repository, storage, async (user, project) => {
    if (user !== '1' || project !== '3')
      throw new FileError(403, 'PROJECT_FORBIDDEN', 'Нет доступа');
  });
  const server = createServer(
    createHandler(
      service,
      async (header) => {
        if (!header) throw new FileError(401, 'UNAUTHORIZED', 'Нужна сессия');
        return header === 'Bearer owner' ? '1' : '2';
      },
      async () => {},
    ),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
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
    headers: { Authorization: 'Bearer owner' },
  });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
