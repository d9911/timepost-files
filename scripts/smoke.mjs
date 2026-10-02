import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

if (process.env.STORAGE_PROVIDER !== 'simulator')
  throw new Error(
    'Этот автоматический smoke выполняется только в симуляторе; облачный прогон требует отдельной настройки.',
  );
const origin = 'http://127.0.0.1:3050';
const headers = { Authorization: `Bearer ${process.env.FILES_API_KEY}` };
const fixturePath = '/tmp/files-smoke-fixture.json';
const phase = process.argv[2] ?? 'all';
async function request(path, options = {}) {
  const response = await fetch(origin + path, {
    ...options,
    headers: { ...headers, ...options.headers },
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response;
}
if (phase !== 'finish') {
  assert.equal((await fetch(origin + '/api/v1/files?projectId=1')).status, 401);
  const projectId = String(Date.now());
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#008800' } })
    .png()
    .toBuffer();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ids = [];
  for (const [name, body, mime] of [
    ['photo.png', bytes, 'image/png'],
    ['note.txt', Buffer.from('Проверка файлового API'), 'text/plain'],
  ]) {
    const result = await (
      await request(`/api/v1/files?projectId=${projectId}&fileName=${name}`, {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body,
      })
    ).json();
    ids.push(result.data.id);
  }
  const page = await (await request(`/api/v1/files?projectId=${projectId}&limit=1`)).json();
  assert.equal(page.data.items.length, 1);
  assert.ok(page.data.nextCursor);
  const next = await (
    await request(`/api/v1/files?projectId=${projectId}&limit=1&cursor=${page.data.nextCursor}`)
  ).json();
  assert.equal(next.data.items.length, 1);
  assert.notEqual(next.data.items[0].id, page.data.items[0].id);
  assert.equal(next.data.nextCursor, null);
  const denied = await fetch(origin + `/api/v1/files/${ids[0]}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.FILES_READONLY_API_KEY}` },
  });
  assert.equal(denied.status, 403);
  await writeFile(fixturePath, JSON.stringify({ projectId, ids, sha256 }), { mode: 0o600 });
  console.log(
    'PASS: загрузка PNG и произвольного файла, пагинация, 401 и запрет удаления readonly-ключом.',
  );
}
if (phase !== 'prepare') {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const image = Buffer.from(
    await (await request(`/api/v1/files/${fixture.ids[0]}/content`)).arrayBuffer(),
  );
  assert.equal(createHash('sha256').update(image).digest('hex'), fixture.sha256);
  const metadata = await (await request(`/api/v1/files/${fixture.ids[0]}`)).json();
  assert.equal(metadata.data.sha256, fixture.sha256);
  assert.equal(metadata.data.width, 2);
  for (const id of fixture.ids) {
    const result = await request(`/api/v1/files/${id}`, { method: 'DELETE' });
    assert.equal(result.status, 202);
    let deleted = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await fetch(origin + `/api/v1/files/${id}`, { headers })).status === 404) {
        deleted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(deleted, 'Worker не завершил удаление');
    const job = await (await request(`/api/v1/files/${id}/deletion`)).json();
    assert.equal(job.data.status, 'done');
    assert.equal(job.data.attempts, 1);
  }
  const list = await (await request(`/api/v1/files?projectId=${fixture.projectId}`)).json();
  assert.equal(list.data.items.length, 0);
  console.log(
    'PASS: байты и SHA-256 сохранены; worker удалил только созданные этим прогоном файлы.',
  );
}
