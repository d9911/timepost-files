import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { FileRecord } from '../../src/modules/files/domain/file.js';
import type { FileRepositoryPort } from '../../src/modules/files/application/ports/file-repository.js';
import type { DirectUploadRepositoryPort } from '../../src/modules/files/application/ports/direct-upload-repository.js';
import type { DirectUploadStoragePort } from '../../src/modules/files/application/ports/direct-upload-storage.js';
import type { StoragePort } from '../../src/modules/files/application/ports/object-storage.js';
import { createFileService } from '../../src/app/create-file-service.js';
import { DirectUploadService } from '../../src/modules/files/application/direct-upload-service.js';
import { ValidatedMediaInspector } from '../../src/modules/files/infrastructure/media/media-inspector.js';
import { CryptoFileIdentity } from '../../src/modules/files/infrastructure/identity/crypto-file-identity.js';
import { createHandler } from '../../src/modules/files/presentation/http/file-handler.js';
import { FileError } from '../../src/shared/application/file-error.js';
export async function directHttpFixture(port = 0) {
  const files = new Map<string, FileRecord>();
  const objects = new Map<
    string,
    { bytes: Buffer; mimeType: string; metadata: Record<string, string> }
  >();
  const reservations = new Map<
    string,
    { mimeType: string; size: number; metadata: Record<string, string> }
  >();
  let origin = '';
  const repository: FileRepositoryPort & DirectUploadRepositoryPort = {
    async insert(file) {
      files.set(file.id, { ...file, status: 'pending' });
    },
    async get(id) {
      return files.get(id);
    },
    async setStatus(id, status) {
      files.get(id)!.status = status;
    },
    async list() {
      return [...files.values()].filter((f) => f.status === 'ready');
    },
    async queueDelete() {},
    async deleteStatus() {
      return undefined;
    },
    async setMultipart(id, uploadId) {
      files.get(id)!.multipartUploadId = uploadId;
    },
    async cancelUpload(id) {
      const f = files.get(id)!;
      if (f.status === 'pending') f.status = 'deleting';
    },
    async completeUpload(id, owner, work) {
      const f = files.get(id)!;
      if (f.ownerId !== owner || f.status === 'deleting')
        throw new FileError('FILE_NOT_FOUND', 'upload');
      if (f.status !== 'ready') Object.assign(f, await work(f), { status: 'ready' });
      return f;
    },
  };
  const stream = (bytes: Buffer): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  });
  const storage: StoragePort & DirectUploadStoragePort = {
    provider: 'yandex-object',
    bucket: 'fixture',
    async ready() {},
    async upload() {},
    async download(id, key) {
      return stream(objects.get(key ?? id)!.bytes);
    },
    async delete() {},
    async presignPut(key, mime, size, metadata) {
      reservations.set(key, { mimeType: mime, size, metadata });
      return `${origin}/mock-s3?key=${encodeURIComponent(key)}`;
    },
    async presignGet(key) {
      return `${origin}/mock-s3?key=${encodeURIComponent(key)}`;
    },
    async createMultipart() {
      return randomUUID();
    },
    async presignPart() {
      throw new Error('multipart fixture unsupported');
    },
    async completeMultipart() {},
    async abortMultipart() {},
    async listParts() {
      return [];
    },
    async headObject(key) {
      const obj = objects.get(key);
      if (!obj) {
        const e = new Error('missing');
        e.name = 'NotFound';
        throw e;
      }
      return {
        sizeBytes: obj.bytes.length,
        mimeType: obj.mimeType,
        metadata: obj.metadata,
        etag: '"fixture"',
      };
    },
    async downloadObject(key, _etag, range) {
      const obj = objects.get(key)!;
      if (range) {
        const m = /bytes=(\d+)-(\d+)/.exec(range)!;
        return stream(obj.bytes.subarray(Number(m[1]), Number(m[2]) + 1));
      }
      return stream(obj.bytes);
    },
    async promoteObject(from, to) {
      objects.set(to, objects.get(from)!);
    },
    async deleteObject(key) {
      objects.delete(key);
    },
  };
  const authorize = async (owner: string, project: string) => {
    if (owner !== '1' || project !== '3') throw new FileError('PROJECT_FORBIDDEN', 'project');
  };
  const service = createFileService(repository, storage, authorize, { deleteEnabled: true });
  const direct = new DirectUploadService(
    repository,
    storage,
    authorize,
    new ValidatedMediaInspector(),
    new CryptoFileIdentity(),
  );
  const handler = createHandler(
    service,
    async (header) => {
      if (header !== 'Bearer fixture-owner') throw new FileError('UNAUTHORIZED', 'token');
      return '1';
    },
    async () => {},
    {
      uiEnabled: true,
      authMode: 'api-key',
      storageProvider: 'yandex-object',
      contentPrefix: '',
      directUploads: direct,
      maxFileBytes: async () => 150_000_000,
      staticDirectory: new URL('../../public/', import.meta.url),
    },
  );
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://localhost');
    if (url.pathname === '/mock-s3') {
      const key = url.searchParams.get('key')!;
      if (req.method === 'PUT') {
        const reservation = reservations.get(key);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (
          !reservation ||
          req.headers.authorization ||
          bytes.length !== reservation.size ||
          req.headers['content-type'] !== reservation.mimeType ||
          req.headers['if-none-match'] !== '*'
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        objects.set(key, { bytes, mimeType: reservation.mimeType, metadata: reservation.metadata });
        res.writeHead(200, { ETag: '"fixture"' });
        res.end();
        return;
      }
      const obj = objects.get(key);
      res.writeHead(obj ? 200 : 404, { 'Content-Type': obj?.mimeType ?? 'text/plain' });
      res.end(obj?.bytes);
      return;
    }
    await handler(req, res);
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return { origin, files, objects, server };
}
