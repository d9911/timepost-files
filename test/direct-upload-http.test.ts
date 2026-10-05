import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { directHttpFixture } from './support/direct-http-fixture.js';
test('HTTP direct upload: UI assets/CSP, authorized init, raw signed PUT, complete, Range and signed GET', async (t) => {
  const f = await directHttpFixture();
  t.after(() => new Promise<void>((resolve) => f.server.close(() => resolve())));
  const headers = { Authorization: 'Bearer fixture-owner', 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) =>
    fetch(f.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const ui = await fetch(f.origin + '/');
  assert.match(
    ui.headers.get('Content-Security-Policy') ?? '',
    /connect-src .*https:\/\/storage\.yandexcloud\.net/,
  );
  assert.equal((await fetch(f.origin + '/direct-upload.js')).status, 200);
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fc0' } })
    .png()
    .toBuffer();
  const input = {
    projectId: '3',
    fileName: 'photo.png',
    mimeType: 'image/png',
    sizeBytes: bytes.length,
    socialNetwork: 'instagram',
  };
  assert.equal(
    (
      await fetch(f.origin + '/api/v1/media/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).status,
    401,
  );
  const initialized = await post('/api/v1/media/upload/init', input);
  assert.equal(initialized.status, 201);
  const { data } = await initialized.json();
  assert.equal(
    (await fetch(data.uploadUrl, { method: 'PUT', headers: data.headers, body: bytes })).status,
    200,
  );
  const complete = await post('/api/v1/media/upload/complete', { uploadId: data.uploadId });
  assert.equal(complete.status, 200);
  const ready = (await complete.json()).data;
  assert.equal(ready.directDownload, true);
  assert.equal(ready.sizeBytes, bytes.length);
  assert.equal(
    [...f.objects.keys()].every((k) => k.startsWith('media/')),
    true,
  );
  const repeat = await post('/api/v1/media/upload/complete', { uploadId: data.uploadId });
  assert.equal((await repeat.json()).data.id, ready.id);
  const range = await fetch(f.origin + ready.url, {
    headers: { Authorization: 'Bearer fixture-owner', Range: 'bytes=2-7' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), `bytes 2-7/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(2, 8));
  const download = await fetch(f.origin + `/api/v1/files/${ready.id}/download`, { headers });
  assert.equal(download.status, 200);
  const signed = (await download.json()).data;
  assert.deepEqual(Buffer.from(await (await fetch(signed.url)).arrayBuffer()), bytes);
  assert.equal((await post('/api/v1/media/upload/cancel', { uploadId: ready.id })).status, 409);
});
