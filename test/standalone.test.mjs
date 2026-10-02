import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configure } from '../src/config.mjs';
import { processDelete } from '../src/delete-worker.mjs';
import { LocalStorage } from '../src/local-storage.mjs';
import { FileService } from '../src/service.mjs';

test('автономная авторизация сохраняет readonly и не включает удаление в режиме Timepost', async () => {
  const env = {
    FILES_AUTH_MODE: 'api-key',
    FILES_API_KEY: 'a'.repeat(32),
    FILES_READONLY_API_KEY: 'b'.repeat(32),
    STORAGE_PROVIDER: 'simulator',
    FILES_DELETE_ENABLED: 'true',
  };
  const config = configure(env);
  assert.equal(config.options.deleteEnabled, true);
  const timepost = configure({
    ...env,
    FILES_AUTH_MODE: 'timepost',
    SYSTEM_JWT_SECRET: 's'.repeat(32),
    SYSTEM_JWT_ISSUER: 'test',
    SYSTEM_JWT_AUDIENCE: 'test',
    ACCOUNTS_SERVICE_URL: 'http://accounts',
    PROJECTS_SERVICE_URL: 'http://projects',
  });
  assert.equal(timepost.options.deleteEnabled, false);
  assert.equal(await config.authorization.authenticate(`Bearer ${env.FILES_API_KEY}`), '1');
  assert.equal(
    await config.authorization.authenticate(`Bearer ${env.FILES_READONLY_API_KEY}`),
    '2',
  );
  await assert.rejects(config.authorization.authorizeProject('2', '1', true));
  await assert.rejects(config.authorization.authenticate('Bearer wrong'));
  assert.throws(() => configure({ ...env, STORAGE_PROVIDER: 'unknown' }));
  assert.throws(() => configure({ ...env, FILES_READONLY_API_KEY: env.FILES_API_KEY }));
});

test('симулятор сохраняет байты после создания нового адаптера и не допускает traversal', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'files-provider-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'cf317e30-e001-4d07-9ff1-43f83d90de16';
  const storage = new LocalStorage(directory);
  await storage.upload(id, Buffer.from('файл'));
  assert.equal(await (await new LocalStorage(directory).download(id)).text(), 'файл');
  assert.throws(() => storage.path('../secret'));
  await assert.rejects(storage.upload(id, Buffer.from('перезапись')));
  await storage.delete(id);
  await storage.delete(id);
  await assert.rejects(storage.download(id));
});

test('произвольный файл получает checksum, имя и безопасный MIME; удаление запрещено без настройки', async () => {
  const repository = { insert: async () => {}, setStatus: async () => {} };
  const service = new FileService(
    repository,
    { provider: 'simulator', upload: async () => {} },
    async () => {},
    { genericFiles: true, contentPrefix: '' },
  );
  const file = await service.upload('1', '3', Buffer.from('hello'), 'text/html', 'file.html');
  assert.equal(file.mimeType, 'application/octet-stream');
  assert.equal(file.width, null);
  assert.equal(file.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.ok(file.url.startsWith('/api/v1/files/'));
  await assert.rejects(service.upload('1', '3', Buffer.from('hello'), 'text/plain', 'bad\nname'));
  await assert.rejects(service.delete(file.id, '1'), (error) => error.code === 'DELETE_DISABLED');
});

test('worker подтверждает удаление после провайдера, а сбой ставит устойчивый повтор', async () => {
  const events = [],
    job = { fileId: 'id', leaseId: 'lease' };
  const repository = {
    claimDelete: async () => job,
    completeDelete: async () => events.push('complete'),
    retryDelete: async () => events.push('retry'),
  };
  await processDelete(repository, { delete: async () => events.push('deleted') });
  assert.deepEqual(events, ['deleted', 'complete']);
  events.length = 0;
  await processDelete(repository, {
    delete: async () => {
      throw new Error('provider');
    },
  });
  assert.deepEqual(events, ['retry']);
});
