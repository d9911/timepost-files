import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import { inspectUploadedStream } from '../src/modules/files/infrastructure/media/inspect-uploaded-stream.js';
import {
  DirectUploadService,
  partSize,
} from '../src/modules/files/application/direct-upload-service.js';
import type { DirectUploadStoragePort } from '../src/modules/files/application/ports/direct-upload-storage.js';
import type { DirectUploadRepositoryPort } from '../src/modules/files/application/ports/direct-upload-repository.js';
import type { FileRecord } from '../src/modules/files/domain/file.js';
import { FileError } from '../src/shared/application/file-error.js';

const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const input = { projectId: '2', fileName: 'photo.png', mimeType: 'image/png', sizeBytes: 3 };
function harness() {
  const calls: string[] = [];
  const files = new Map<string, FileRecord>();
  let bytes: Buffer = Buffer.from('png');
  let headOverride: Partial<Awaited<ReturnType<DirectUploadStoragePort['headObject']>>> = {};
  let deny = false;
  let failSign = false;
  let failInspector = false;
  let inspectedPath = '';
  let parts: { partNumber: number; sizeBytes: number; etag: string }[] = [];
  let incomingExists = true;
  const repo: DirectUploadRepositoryPort = {
    async insert(file) {
      calls.push('reserve');
      files.set(file.id, { ...file, status: 'pending' });
    },
    async get(fileId) {
      return files.get(fileId);
    },
    async setMultipart(fileId, uploadId) {
      files.get(fileId)!.multipartUploadId = uploadId;
    },
    async cancelUpload(fileId, ownerId) {
      calls.push('cancel');
      const file = files.get(fileId);
      if (file?.ownerId === ownerId && file.status === 'pending') file.status = 'deleting';
    },
    async completeUpload(fileId, ownerId, work) {
      const file = files.get(fileId)!;
      if (file.ownerId !== ownerId || file.status === 'deleting' || file.status === 'deleted')
        throw new FileError('FILE_NOT_FOUND', 'cancelled');
      if (file.status === 'ready') return file;
      const metadata = await work(file);
      Object.assign(file, metadata, { status: 'ready' });
      calls.push('ready');
      return file;
    },
  };
  const storage: DirectUploadStoragePort = {
    bucket: 'test-media',
    async presignPut() {
      calls.push('sign');
      if (failSign) throw new Error('sign failure');
      return 'https://signed.example.test';
    },
    async presignGet() {
      return 'https://download.example.test';
    },
    async createMultipart() {
      calls.push('multipart-init');
      return 's3-upload';
    },
    async presignPart() {
      return 'https://part.example.test';
    },
    async listParts() {
      return parts;
    },
    async completeMultipart() {
      calls.push('multipart-complete');
      incomingExists = true;
    },
    async abortMultipart() {
      calls.push('abort');
    },
    async headObject() {
      if (!incomingExists) {
        const error = new Error('not found');
        error.name = 'NotFound';
        throw error;
      }
      const file = files.get(id)!;
      return {
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        etag: '"source-etag"',
        metadata: { 'upload-id': id, 'owner-id': '1', 'project-id': '2' },
        ...headOverride,
      };
    },
    async downloadObject(key, etag) {
      calls.push('download');
      assert.equal(key, files.get(id)!.incomingKey);
      assert.equal(etag, '"source-etag"');
      return (async function* () {
        yield bytes.subarray(0, 1);
        yield bytes.subarray(1);
      })();
    },
    async promoteObject(source, target, size, etag) {
      calls.push('promote');
      assert.equal(source, `incoming/1/2/${id}/original.png`);
      assert.equal(target, `media/1/2/${id}/original.png`);
      assert.equal(size, bytes.length);
      assert.equal(etag, '"source-etag"');
    },
    async deleteObject() {
      calls.push('delete-incoming');
    },
  };
  const service = new DirectUploadService(
    repo,
    storage,
    async (owner, project, write) => {
      calls.push('authorize');
      assert.equal(owner, '1');
      assert.equal(project, '2');
      assert.equal(write, true);
      if (deny) throw new FileError('FILE_FORBIDDEN', 'denied');
    },
    {
      async inspect() {
        throw new Error('buffer inspection must not run');
      },
      async inspectStream(stream, mimeType, sizeBytes) {
        return inspectUploadedStream(stream, sizeBytes, async (path) => {
          calls.push('inspect');
          inspectedPath = path;
          assert.equal(mimeType, 'image/png');
          assert.deepEqual(await readFile(path), bytes);
          if (failInspector) throw new FileError('INVALID_IMAGE', 'corrupt image');
          return { mimeType: 'image/png', width: 1, height: 1 };
        });
      },
    },
    {
      createId: () => id,
      checksum: () => {
        throw new Error('buffer checksum must not run');
      },
    },
  );
  return {
    service,
    calls,
    files,
    setBytes(value: Buffer) {
      bytes = value;
    },
    setHead(value: typeof headOverride) {
      headOverride = value;
    },
    deny() {
      deny = true;
    },
    failSign() {
      failSign = true;
    },
    failInspector() {
      failInspector = true;
    },
    setParts(value: typeof parts) {
      parts = value;
      incomingExists = false;
    },
    get inspectedPath() {
      return inspectedPath;
    },
  };
}

test('upload init authorizes project before reservation; foreign owners cannot complete/cancel', async () => {
  const h = harness();
  h.deny();
  await assert.rejects(h.service.init('1', input), /denied/);
  assert.equal(h.files.size, 0);
  assert.ok(!h.calls.includes('sign'));
  const owned = harness();
  await owned.service.init('1', input);
  const before = owned.calls.length;
  await assert.rejects(owned.service.complete('9', id), /не найдена/);
  await assert.rejects(owned.service.cancel('9', id), /не найдена/);
  assert.equal(owned.calls.length, before);
  assert.equal(owned.files.get(id)!.status, 'pending');
});

test('quota reservation precedes signing, signing failure cancels reservation', async () => {
  const h = harness();
  h.failSign();
  await assert.rejects(h.service.init('1', input), /sign failure/);
  assert.deepEqual(h.calls, ['authorize', 'reserve', 'sign', 'cancel']);
  assert.equal(h.files.get(id)!.status, 'deleting');
});

test('mismatched object size, MIME and ownership metadata never promote', async () => {
  for (const override of [
    { sizeBytes: 4 },
    { mimeType: 'video/mp4' },
    { metadata: { 'upload-id': id, 'owner-id': '9', 'project-id': '2' } },
  ]) {
    const h = harness();
    await h.service.init('1', input);
    h.setHead(override);
    await assert.rejects(h.service.complete('1', id), /не совпадают/);
    assert.ok(!h.calls.includes('download'));
    assert.ok(!h.calls.includes('promote'));
    assert.equal(h.files.get(id)!.status, 'pending');
  }
});

test('stream overflow, truncation and invalid media do not promote and remove private spool', async () => {
  for (const mode of ['overflow', 'short', 'format']) {
    const h = harness();
    await h.service.init('1', input);
    if (mode === 'overflow') h.setBytes(Buffer.from('long'));
    if (mode === 'short') h.setBytes(Buffer.from('p'));
    if (mode === 'format') h.failInspector();
    await assert.rejects(h.service.complete('1', id));
    assert.ok(!h.calls.includes('promote'));
    assert.equal(h.files.get(id)!.status, 'pending');
    if (h.inspectedPath) await assert.rejects(readFile(h.inspectedPath), { code: 'ENOENT' });
  }
});

test('valid PNG completes incoming to media with SHA256 and ready; retry is idempotent', async () => {
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  const h = harness();
  h.setBytes(bytes);
  await h.service.init('1', { ...input, sizeBytes: bytes.length });
  const result = await h.service.complete('1', id);
  assert.equal(result.status, 'ready');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.width, 1);
  assert.ok(h.calls.indexOf('promote') < h.calls.indexOf('ready'));
  assert.ok(h.calls.indexOf('ready') < h.calls.indexOf('delete-incoming'));
  await assert.rejects(readFile(h.inspectedPath), { code: 'ENOENT' });
  await h.service.complete('1', id);
  assert.equal(h.calls.filter((call) => call === 'promote').length, 1);
});

test('multipart rejects mismatched part ETags before S3 completion', async () => {
  const h = harness();
  const size = 100_000_000;
  await h.service.init('1', { ...input, sizeBytes: size });
  const actual = Array.from({ length: Math.ceil(size / partSize) }, (_, i) => ({
    partNumber: i + 1,
    sizeBytes: Math.min(partSize, size - i * partSize),
    etag: `etag-${i}`,
  }));
  h.setParts(actual);
  await assert.rejects(
    h.service.complete(
      '1',
      id,
      actual.map((part) => ({ partNumber: part.partNumber, etag: 'wrong' })),
    ),
    /неверные части/,
  );
  assert.ok(!h.calls.includes('multipart-complete'));
  assert.ok(!h.calls.includes('promote'));
});

test('cancelled upload cannot become ready', async () => {
  const h = harness();
  await h.service.init('1', input);
  await h.service.cancel('1', id);
  await assert.rejects(h.service.complete('1', id));
  assert.equal(h.files.get(id)!.status, 'deleting');
  assert.ok(!h.calls.includes('promote'));
  assert.ok(!h.calls.includes('ready'));
});
