import assert from 'node:assert/strict';
import test from 'node:test';
import { directHttpFixture } from './support/direct-http-fixture.js';

test('publisher media URL requires service authentication and a ready file retained by the post', async (t) => {
  const f = await directHttpFixture(0, true);
  t.after(() => new Promise<void>((resolve) => f.server.close(() => resolve())));
  const fileId = '49832b20-c37c-4bde-a910-c6304f344b8c';
  f.files.set(fileId, {
    id: fileId,
    ownerId: '1',
    projectId: '3',
    mimeType: 'image/jpeg',
    sizeBytes: 10,
    width: 1,
    height: 1,
    bucket: 'fixture',
    objectKey: 'media/test.jpg',
    provider: 'yandex-object',
    status: 'ready',
  });
  const post = (body: unknown, token = 'fixture-posts') =>
    fetch(f.origin + '/api/v1/internal/publication-media', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const body = { fileId, projectId: '3', referenceId: 'post:9' };
  assert.equal((await post(body, 'fixture-owner')).status, 401);
  assert.equal((await post(body)).status, 404);
  f.references.set('3:post:9', [fileId]);
  const response = await post(body);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.expiresIn, 900);
  assert.match(data.url, /mock-s3/);
  assert.equal((await post({ ...body, projectId: '4' })).status, 404);
  assert.equal((await post({ ...body, referenceId: 'post:10' })).status, 404);
  f.files.get(fileId)!.status = 'deleting';
  assert.equal((await post(body)).status, 404);
  assert.equal((await post({ ...body, referenceId: 'user:1' })).status, 400);
});
