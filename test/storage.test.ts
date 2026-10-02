import { bytesStream } from './support/byte-stream.js';
import { FileError } from '../src/shared/application/file-error.js';
import type { FileRecord } from '../src/modules/files/domain/file.js';
import type { FileRepositoryPort } from '../src/modules/files/application/ports/file-repository.js';
import type { StoragePort } from '../src/modules/files/application/ports/object-storage.js';
import type { HttpRequest } from '../src/shared/infrastructure/http-request.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import sharp from 'sharp';

import { createFileService } from '../src/app/create-file-service.js';
import {
  validateTransferUrl,
  YandexDiskStorage,
} from '../src/modules/files/infrastructure/storage/yandex-disk-storage.js';

function setup() {
  const rows = new Map<string, FileRecord>();
  const calls: Parameters<StoragePort['upload']>[] = [];
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
    download: async () => bytesStream(new Uint8Array()),
    delete: async () => {},
    upload: async (...args) => {
      calls.push(args);
    },
  };
  const service = createFileService(repository, storage, async (user, project) => {
    if (user !== '1' || project !== '3') throw new Error('denied');
  });
  return { rows, calls, storage, service };
}

test('сохраняет фотографию и отдаёт только подтверждённые метаданные', async () => {
  const { rows, calls, service } = setup();
  const bytes = await sharp({
    create: { width: 2, height: 3, channels: 3, background: '#00ff00' },
  })
    .png()
    .toBuffer();
  const result = await service.upload('1', '3', bytes);
  assert.equal(result.width, 2);
  assert.equal(result.height, 3);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(rows.get(result.id)!.status, 'ready');
  assert.equal(calls.length, 1);
  assert.deepEqual(await service.metadata(result.id, '1'), result);
  await assert.rejects(service.metadata(result.id, '2'), /denied/);
});

test('не выдаёт незавершённую загрузку и не создаёт успешный ответ при сбое провайдера', async () => {
  const { rows, storage, service } = setup();
  storage.upload = async () => {
    throw new Error('offline');
  };
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#fff' },
  })
    .jpeg()
    .toBuffer();
  await assert.rejects(service.upload('1', '3', bytes), /offline/);
  const [row] = rows.values();
  assert.ok(row);
  assert.equal(row.status, 'pending');
  await assert.rejects(
    service.metadata(row.id, '1'),
    (error) => error instanceof FileError && error.code === 'FILE_NOT_FOUND',
  );
});

test('отклоняет произвольные файлы, размер и неверный проект до записи', async () => {
  const { rows, service } = setup();
  await assert.rejects(
    service.upload('1', '3', Buffer.from('<svg/>')),
    (error) => error instanceof FileError && error.code === 'INVALID_IMAGE',
  );
  await assert.rejects(
    service.upload('1', '3', Buffer.alloc(10485761)),
    (error) => error instanceof FileError && error.code === 'FILE_TOO_LARGE',
  );
  await assert.rejects(
    service.upload('1', '../3', Buffer.from('x')),
    (error) => error instanceof FileError && error.code === 'INVALID_PROJECT',
  );
  assert.equal(rows.size, 0);
});

test('отклоняет подменённые адреса и разрешает только HTTPS хранилища', () => {
  for (const url of [
    'http://disk.yandex.net/a',
    'https://127.0.0.1/a',
    'https://disk.yandex.net.evil.test/a',
    'https://user@disk.yandex.net/a',
    'https://disk.yandex.net:444/a',
  ])
    assert.throws(() => validateTransferUrl(url));
  assert.equal(
    validateTransferUrl('https://uploader44.disk.yandex.net/a').hostname,
    'uploader44.disk.yandex.net',
  );
});

test('OAuth не передаётся по временному адресу загрузки и редиректы запрещены', async () => {
  const calls: { url: string; options: Parameters<HttpRequest>[1] }[] = [];
  const storage = new YandexDiskStorage('private-token', async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json(
      { method: 'PUT', href: 'https://uploader44.disk.yandex.net/a' },
      { status: 201 },
    );
  });
  await storage.upload('file', Buffer.from('image'), 'image/png');
  assert.equal(calls[0]!.options.headers!.Authorization, 'OAuth private-token');
  assert.equal(calls[2]!.options.headers!.Authorization, undefined);
  assert.ok(calls.every((call) => call.options.redirect === 'error'));
});

test('отсутствие OAuth не имитирует успешное хранилище', async () => {
  const storage = new YandexDiskStorage('');
  await assert.rejects(
    storage.upload('file', Buffer.from('x'), 'image/png'),
    (error) => error instanceof FileError && error.code === 'STORAGE_NOT_CONFIGURED',
  );
});
