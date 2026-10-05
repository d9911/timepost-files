import { constants, createReadStream } from 'node:fs';
import { mkdir, lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { S3Error } from '../domain/s3-error.js';

export interface StoredObjectInput {
  contentType?: string;
  metadata?: Record<string, string>;
  contentEncoding?: string;
  cacheControl?: string;
  contentDisposition?: string;
  checksumSha256?: string;
  checksums?: Record<string, string>;
}
export interface StoredObject extends StoredObjectInput {
  key: string;
  sizeBytes: number;
  etag: string;
  lastModified: string;
  contentType: string;
  metadata: Record<string, string>;
}
export interface ObjectWriteOptions {
  expectedSize?: number;
  expectedSha256?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
  validate?: () => Promise<void>;
}
export interface MultipartPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  lastModified: string;
}
export interface MultipartUpload {
  uploadId: string;
  key: string;
  initiated: string;
  metadata: StoredObjectInput;
}
interface Manifest {
  object: StoredObject;
  blob: string;
}
interface PartManifest {
  part: MultipartPart;
  blob: string;
}
const MAX_PART_BYTES = 5 * 1024 ** 3;
const MIN_PART_BYTES = 5 * 1024 ** 2;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (code: string, message: string, status: number): never => {
  throw new S3Error(code, message, status);
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** One process owns this directory. Immutable blobs and atomic manifest replacement
 * ensure a failed upload cannot replace the previous committed object. */
export class LocalObjectStore {
  private readonly directory: string;
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    directory: string,
    private readonly maxObjectBytes = 10_000_000_000,
  ) {
    this.directory = resolve(directory);
  }
  async initialize(): Promise<void> {
    await this.safeDirectory(this.directory);
  }
  private async safeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      fail('InternalError', 'Unsafe storage directory', 500);
  }
  private bucketPath(bucket: string): string {
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket.includes('..') ||
      bucket.includes('.-') ||
      bucket.includes('-.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
    ) {
      fail('InvalidBucketName', 'Invalid bucket name', 400);
    }
    return join(this.directory, bucket);
  }
  private validateKey(key: string): void {
    if (!key || Buffer.byteLength(key) > 1024)
      fail('KeyTooLongError', 'Object key must contain 1 to 1024 UTF-8 bytes', 400);
  }
  private async lock<T>(bucket: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(bucket) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((done) => {
      release = done;
    });
    const tail = previous.then(() => current);
    this.locks.set(bucket, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(bucket) === tail) this.locks.delete(bucket);
    }
  }
  private async json<T>(path: string): Promise<T> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return JSON.parse(await handle.readFile('utf8')) as T;
    } finally {
      await handle.close();
    }
  }
  private async atomicJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  private async bucket(bucket: string): Promise<string> {
    const path = this.bucketPath(bucket);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        fail('InternalError', 'Unsafe bucket directory', 500);
      await this.json(join(path, 'bucket.json'));
      for (const child of ['objects', 'blobs', 'uploads']) {
        const stat = await lstat(join(path, child));
        if (!stat.isDirectory() || stat.isSymbolicLink())
          fail('InternalError', 'Unsafe storage directory', 500);
      }
      return path;
    } catch (error) {
      if (missing(error)) fail('NoSuchBucket', 'The specified bucket does not exist', 404);
      throw error;
    }
  }
  async listBuckets(): Promise<{ name: string; createdAt: string }[]> {
    await this.initialize();
    const entries = await readdir(this.directory, { withFileTypes: true });
    const result: { name: string; createdAt: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        result.push(
          await this.lock(entry.name, async () =>
            this.json<{ name: string; createdAt: string }>(
              join(await this.bucket(entry.name), 'bucket.json'),
            ),
          ),
        );
      } catch (error) {
        if (error instanceof S3Error && ['InvalidBucketName', 'NoSuchBucket'].includes(error.code))
          continue;
        throw error;
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async createBucket(name: string): Promise<void> {
    await this.lock(name, async () => {
      await this.initialize();
      const path = this.bucketPath(name);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          fail('BucketAlreadyOwnedByYou', 'Bucket already exists', 409);
        throw error;
      }
      try {
        for (const child of ['objects', 'blobs', 'uploads'])
          await this.safeDirectory(join(path, child));
        await this.atomicJson(join(path, 'bucket.json'), {
          name,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async headBucket(name: string): Promise<void> {
    await this.lock(name, async () => {
      await this.bucket(name);
    });
  }
  async deleteBucket(name: string): Promise<void> {
    await this.lock(name, async () => {
      const path = await this.bucket(name);
      if (
        (await readdir(join(path, 'objects'))).some((file) => file.endsWith('.json')) ||
        (await readdir(join(path, 'uploads'))).length
      )
        fail('BucketNotEmpty', 'Bucket is not empty', 409);
      await rm(path, { recursive: true });
    });
  }
  private manifestPath(path: string, key: string): string {
    this.validateKey(key);
    return join(path, 'objects', `${digest(key)}.json`);
  }
  private async manifest(path: string, key: string): Promise<Manifest> {
    try {
      const manifest = await this.json<Manifest>(this.manifestPath(path, key));
      this.blobPath(join(path, 'blobs'), manifest.blob);
      return manifest;
    } catch (error) {
      if (missing(error)) fail('NoSuchKey', 'The specified key does not exist', 404);
      throw error;
    }
  }
  private async optionalManifest(path: string, key: string): Promise<Manifest | undefined> {
    try {
      return await this.manifest(path, key);
    } catch (error) {
      if (error instanceof S3Error && error.code === 'NoSuchKey') return undefined;
      throw error;
    }
  }
  private conditions(object: StoredObject | undefined, options: ObjectWriteOptions): void {
    const matches = (value: string) =>
      value
        .split(',')
        .map((s) => s.trim())
        .includes(object?.etag ?? '') ||
      (value === '*' && !!object);
    if (
      (options.ifMatch && !matches(options.ifMatch)) ||
      (options.ifNoneMatch && matches(options.ifNoneMatch))
    )
      fail('PreconditionFailed', 'At least one precondition failed', 412);
  }
  private async writeBlob(
    path: string,
    stream: AsyncIterable<Uint8Array>,
    options: ObjectWriteOptions,
    limit: number,
  ): Promise<{ blob: string; sizeBytes: number; md5: string; sha256: string }> {
    const blob = randomUUID();
    const destination = join(path, blob);
    const handle = await open(destination, 'wx', 0o600);
    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const bytes of stream) {
        sizeBytes += bytes.byteLength;
        if (sizeBytes > limit) fail('EntityTooLarge', 'Object exceeds configured size limit', 400);
        md5.update(bytes);
        sha256.update(bytes);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const result = await handle.write(bytes, offset, bytes.byteLength - offset);
          offset += result.bytesWritten;
        }
      }
      const hash = sha256.digest('hex');
      if (options.expectedSize !== undefined && options.expectedSize !== sizeBytes)
        fail('IncompleteBody', 'Body size does not match Content-Length', 400);
      if (options.expectedSha256 && options.expectedSha256 !== hash)
        fail('XAmzContentSHA256Mismatch', 'Payload checksum mismatch', 400);
      await options.validate?.();
      await handle.sync();
      const directoryHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return { blob, sizeBytes, md5: md5.digest('hex'), sha256: hash };
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }
  private async put(
    path: string,
    key: string,
    stream: AsyncIterable<Uint8Array>,
    metadata: StoredObjectInput,
    options: ObjectWriteOptions,
    etag?: string,
  ): Promise<StoredObject> {
    const old = await this.optionalManifest(path, key);
    this.conditions(old?.object, options);
    const written = await this.writeBlob(join(path, 'blobs'), stream, options, this.maxObjectBytes);
    const object: StoredObject = {
      ...metadata,
      key,
      sizeBytes: written.sizeBytes,
      etag: etag ?? `"${written.md5}"`,
      lastModified: new Date().toISOString(),
      contentType: metadata.contentType ?? 'application/octet-stream',
      metadata: metadata.metadata ?? {},
    };
    if (
      metadata.checksumSha256 &&
      metadata.checksumSha256 !== Buffer.from(written.sha256, 'hex').toString('base64')
    ) {
      await rm(join(path, 'blobs', written.blob));
      fail('BadDigest', 'Checksum mismatch', 400);
    }
    // Retain the new immutable blob if publication errors: a directory fsync can
    // fail after rename has already published the pointer.
    await this.atomicJson(this.manifestPath(path, key), { object, blob: written.blob });
    if (old) await rm(join(path, 'blobs', old.blob), { force: true });
    return object;
  }
  async putObject(
    bucket: string,
    key: string,
    stream: AsyncIterable<Uint8Array>,
    metadata: StoredObjectInput,
    options: ObjectWriteOptions = {},
  ): Promise<StoredObject> {
    return this.lock(bucket, async () =>
      this.put(await this.bucket(bucket), key, stream, metadata, options),
    );
  }
  async headObject(bucket: string, key: string): Promise<StoredObject> {
    return this.lock(
      bucket,
      async () => (await this.manifest(await this.bucket(bucket), key)).object,
    );
  }
  private blobPath(directory: string, blob: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(blob))
      fail('InternalError', 'Invalid storage manifest', 500);
    return join(directory, blob);
  }
  private async readBlob(
    path: string,
    blob: string,
    range?: { start: number; end: number },
  ): Promise<AsyncIterable<Uint8Array>> {
    if (!/^[a-f0-9-]{36}$/.test(blob)) fail('InternalError', 'Invalid storage manifest', 500);
    const handle = await open(join(path, 'blobs', blob), constants.O_RDONLY | constants.O_NOFOLLOW);
    return handle.createReadStream(
      range ? { start: range.start, end: range.end, autoClose: true } : { autoClose: true },
    );
  }
  async getObject(
    bucket: string,
    key: string,
    selection?:
      | { start: number; end: number }
      | ((size: number) => { start: number; end: number } | undefined),
  ): Promise<{ object: StoredObject; stream: AsyncIterable<Uint8Array> }> {
    return this.lock(bucket, async () => {
      const path = await this.bucket(bucket);
      const { object, blob } = await this.manifest(path, key);
      const range = typeof selection === 'function' ? selection(object.sizeBytes) : selection;
      if (
        range &&
        (!Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          range.end >= object.sizeBytes)
      )
        fail('InvalidRange', 'Requested range is not satisfiable', 416);
      return { object, stream: await this.readBlob(path, blob, range) };
    });
  }
  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.lock(bucket, async () => {
      const path = await this.bucket(bucket);
      const old = await this.optionalManifest(path, key);
      if (old) {
        await rm(this.manifestPath(path, key));
        await rm(join(path, 'blobs', old.blob), { force: true });
      }
    });
  }
  async copyObject(
    sourceBucket: string,
    sourceKey: string,
    targetBucket: string,
    targetKey: string,
    metadata?: StoredObjectInput,
    ifMatch?: string,
  ): Promise<StoredObject> {
    const source = await this.getObject(sourceBucket, sourceKey);
    if (ifMatch && source.object.etag !== ifMatch) {
      if ('destroy' in source.stream)
        (source.stream as ReturnType<typeof createReadStream>).destroy();
      fail('PreconditionFailed', 'Copy source precondition failed', 412);
    }
    try {
      return await this.putObject(
        targetBucket,
        targetKey,
        source.stream,
        metadata ?? source.object,
      );
    } finally {
      if ('destroy' in source.stream)
        (source.stream as ReturnType<typeof createReadStream>).destroy();
    }
  }
  async listObjects(
    bucket: string,
    options: {
      prefix?: string;
      delimiter?: string;
      maxKeys?: number;
      continuationToken?: string;
      startAfter?: string;
    } = {},
  ): Promise<{
    objects: StoredObject[];
    commonPrefixes: string[];
    isTruncated: boolean;
    nextContinuationToken?: string;
  }> {
    return this.lock(bucket, async () => {
      const path = await this.bucket(bucket);
      const prefix = options.prefix ?? '';
      const maxKeys = options.maxKeys ?? 1000;
      if (!Number.isInteger(maxKeys) || maxKeys < 0 || maxKeys > 1000)
        fail('InvalidArgument', 'Invalid max-keys', 400);
      let after = options.startAfter ?? '';
      if (options.continuationToken) {
        try {
          const parsed: unknown = JSON.parse(
            Buffer.from(options.continuationToken, 'base64url').toString(),
          );
          if (typeof parsed !== 'string') throw new Error();
          after = parsed;
        } catch {
          fail('InvalidArgument', 'Invalid continuation token', 400);
        }
      }
      const entries = new Map<string, StoredObject | string>();
      for (const name of await readdir(join(path, 'objects'))) {
        if (!name.endsWith('.json')) continue;
        const { object } = await this.json<Manifest>(join(path, 'objects', name));
        if (!object.key.startsWith(prefix)) continue;
        const index = options.delimiter ? object.key.indexOf(options.delimiter, prefix.length) : -1;
        const key = index < 0 ? object.key : object.key.slice(0, index + options.delimiter!.length);
        if (Buffer.compare(Buffer.from(key), Buffer.from(after)) > 0)
          entries.set(key, index < 0 ? object : key);
      }
      const keys = [...entries.keys()].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
      const selected = keys.slice(0, maxKeys);
      const objects: StoredObject[] = [];
      const commonPrefixes: string[] = [];
      for (const key of selected) {
        const value = entries.get(key)!;
        if (typeof value === 'string') commonPrefixes.push(value);
        else objects.push(value);
      }
      const isTruncated = keys.length > selected.length;
      const last = selected.at(-1);
      return {
        objects,
        commonPrefixes,
        isTruncated,
        ...(isTruncated && last !== undefined
          ? { nextContinuationToken: Buffer.from(JSON.stringify(last)).toString('base64url') }
          : {}),
      };
    });
  }
  private uploadPath(path: string, id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail('NoSuchUpload', 'Multipart upload does not exist', 404);
    return join(path, 'uploads', id);
  }
  private async upload(
    path: string,
    key: string,
    id: string,
  ): Promise<{ path: string; upload: MultipartUpload }> {
    const directory = this.uploadPath(path, id);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        fail('InternalError', 'Unsafe multipart directory', 500);
      const upload = await this.json<MultipartUpload>(join(directory, 'upload.json'));
      if (upload.key !== key) fail('NoSuchUpload', 'Multipart upload does not exist', 404);
      return { path: directory, upload };
    } catch (error) {
      if (missing(error)) fail('NoSuchUpload', 'Multipart upload does not exist', 404);
      throw error;
    }
  }
  async initiateMultipart(
    bucket: string,
    key: string,
    metadata: StoredObjectInput,
  ): Promise<string> {
    return this.lock(bucket, async () => {
      this.validateKey(key);
      const path = await this.bucket(bucket);
      const uploadId = randomUUID();
      const directory = this.uploadPath(path, uploadId);
      await this.safeDirectory(directory);
      await this.atomicJson(join(directory, 'upload.json'), {
        uploadId,
        key,
        initiated: new Date().toISOString(),
        metadata,
      });
      return uploadId;
    });
  }
  async listMultipart(
    bucket: string,
    options: { prefix?: string; maxUploads?: number } = {},
  ): Promise<MultipartUpload[]> {
    return this.lock(bucket, async () => {
      const path = await this.bucket(bucket);
      const result: MultipartUpload[] = [];
      for (const id of await readdir(join(path, 'uploads'))) {
        const directory = this.uploadPath(path, id);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          fail('InternalError', 'Unsafe multipart directory', 500);
        const upload = await this.json<MultipartUpload>(join(directory, 'upload.json'));
        if (upload.key.startsWith(options.prefix ?? '')) result.push(upload);
      }
      return result
        .sort((a, b) => a.key.localeCompare(b.key) || a.initiated.localeCompare(b.initiated))
        .slice(0, options.maxUploads ?? 1000);
    });
  }
  async uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    stream: AsyncIterable<Uint8Array>,
    options: ObjectWriteOptions = {},
  ): Promise<MultipartPart> {
    return this.lock(bucket, async () => {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000)
        fail('InvalidArgument', 'Part number must be between 1 and 10000', 400);
      const upload = await this.upload(await this.bucket(bucket), key, uploadId);
      const written = await this.writeBlob(upload.path, stream, options, MAX_PART_BYTES);
      const part: MultipartPart = {
        partNumber,
        etag: `"${written.md5}"`,
        sizeBytes: written.sizeBytes,
        lastModified: new Date().toISOString(),
      };
      const manifest = join(upload.path, `${partNumber}.json`);
      let old: PartManifest | undefined;
      try {
        old = await this.json(manifest);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await this.atomicJson(manifest, { part, blob: written.blob });
      if (old) await rm(this.blobPath(upload.path, old.blob), { force: true });
      return part;
    });
  }
  private async parts(path: string): Promise<PartManifest[]> {
    const result: PartManifest[] = [];
    for (const name of await readdir(path)) {
      if (/^\d+\.json$/.test(name)) result.push(await this.json<PartManifest>(join(path, name)));
    }
    return result.sort((a, b) => a.part.partNumber - b.part.partNumber);
  }
  async listParts(bucket: string, key: string, uploadId: string): Promise<MultipartPart[]> {
    return this.lock(bucket, async () =>
      (await this.parts((await this.upload(await this.bucket(bucket), key, uploadId)).path)).map(
        (entry) => entry.part,
      ),
    );
  }
  async completeMultipart(
    bucket: string,
    key: string,
    uploadId: string,
    requested: { partNumber: number; etag: string }[],
    options: ObjectWriteOptions = {},
  ): Promise<StoredObject> {
    return this.lock(bucket, async () => {
      const path = await this.bucket(bucket);
      const upload = await this.upload(path, key, uploadId);
      const available = new Map(
        (await this.parts(upload.path)).map((entry) => [entry.part.partNumber, entry]),
      );
      if (!requested.length || requested.length > 10000)
        fail('InvalidPart', 'Invalid multipart completion', 400);
      const selected: PartManifest[] = [];
      let previous = 0;
      for (const part of requested) {
        if (part.partNumber <= previous)
          fail('InvalidPartOrder', 'Parts must be ordered by part number', 400);
        previous = part.partNumber;
        const stored = available.get(part.partNumber);
        if (!stored || stored.part.etag !== part.etag)
          return fail('InvalidPart', 'Part or ETag does not match', 400);

        selected.push(stored);
      }
      for (const entry of selected.slice(0, -1)) {
        if (entry.part.sizeBytes < MIN_PART_BYTES)
          fail('EntityTooSmall', 'Each part except the last must be at least 5 MiB', 400);
      }
      const hash = createHash('md5');
      for (const entry of selected) hash.update(Buffer.from(entry.part.etag.slice(1, -1), 'hex'));
      const etag = `"${hash.digest('hex')}-${selected.length}"`;
      const stream = async function* () {
        for (const entry of selected) {
          const handle = await open(
            join(upload.path, entry.blob),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            yield* handle.createReadStream({ autoClose: false });
          } finally {
            await handle.close();
          }
        }
      };
      const object = await this.put(path, key, stream(), upload.upload.metadata, options, etag);
      await rm(upload.path, { recursive: true, force: true });
      return object;
    });
  }
  async abortMultipart(bucket: string, key: string, uploadId: string): Promise<void> {
    await this.lock(bucket, async () => {
      const upload = await this.upload(await this.bucket(bucket), key, uploadId);
      await rm(upload.path, { recursive: true });
    });
  }
}
