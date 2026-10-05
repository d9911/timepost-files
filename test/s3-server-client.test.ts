import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  PutBucketVersioningCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LocalObjectStore } from '../src/modules/s3/infrastructure/local-object-store.js';
import { createS3Handler } from '../src/modules/s3/presentation/s3-handler.js';

const credentials = { accessKeyId: 'local-access', secretAccessKey: 'local-secret-for-tests' };
const region = 'ru-central1';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'files-native-s3-'));
  const store = new LocalObjectStore(directory);
  await store.initialize();
  const server = createServer(createS3Handler(store, { ...credentials, region }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new S3Client({
    endpoint,
    region,
    credentials,
    forcePathStyle: true,
    maxAttempts: 1,
  });
  t.after(async () => {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  const Bucket = 'native-s3-tests';
  await client.send(new CreateBucketCommand({ Bucket }));
  return { client, endpoint, Bucket };
}

test('native S3: реальный SDK выполняет bucket CRUD и получает XML ошибки', async (t) => {
  const { client, Bucket } = await fixture(t);
  assert.ok(
    (await client.send(new ListBucketsCommand({}))).Buckets?.some(
      (bucket) => bucket.Name === Bucket,
    ),
  );
  await client.send(new HeadBucketCommand({ Bucket }));
  assert.equal(
    (await client.send(new GetBucketLocationCommand({ Bucket }))).LocationConstraint,
    region,
  );
  await assert.rejects(client.send(new GetObjectCommand({ Bucket, Key: 'missing' })), {
    name: 'NoSuchKey',
  });
  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket: 'missing-bucket', Key: 'missing' })),
    { name: 'NoSuchBucket' },
  );
  await client.send(new PutObjectCommand({ Bucket, Key: 'keep', Body: 'data' }));
  await assert.rejects(client.send(new DeleteBucketCommand({ Bucket })), {
    name: 'BucketNotEmpty',
  });
  await client.send(new DeleteObjectCommand({ Bucket, Key: 'keep' }));
  await client.send(new DeleteBucketCommand({ Bucket }));
  assert.ok(
    !(await client.send(new ListBucketsCommand({}))).Buckets?.some(
      (bucket) => bucket.Name === Bucket,
    ),
  );
});

test('native S3: SDK сохраняет байты, metadata, Range, overwrite и CopyObject', async (t) => {
  const { client, Bucket } = await fixture(t);
  const Key = 'media/фото & + %.txt';
  const bytes = Buffer.from('zero-one-two-three');
  const put = await client.send(
    new PutObjectCommand({
      Bucket,
      Key,
      Body: bytes,
      ContentType: 'text/plain',
      Metadata: { source: 'local-test' },
    }),
  );
  assert.ok(put.ETag);
  const head = await client.send(new HeadObjectCommand({ Bucket, Key }));
  assert.equal(head.ContentLength, bytes.length);
  assert.equal(head.ContentType, 'text/plain');
  assert.deepEqual(head.Metadata, { source: 'local-test' });
  assert.equal(head.ETag, put.ETag);
  const listed = await client.send(new ListObjectsV2Command({ Bucket, Prefix: 'media/' }));
  assert.deepEqual(
    listed.Contents?.map((object) => object.Key),
    [Key],
  );
  const get = await client.send(new GetObjectCommand({ Bucket, Key }));
  assert.deepEqual(Buffer.from(await get.Body!.transformToByteArray()), bytes);
  const ranged = await client.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=5-7' }));
  assert.equal(await ranged.Body!.transformToString(), 'one');
  assert.equal(ranged.ContentRange, `bytes 5-7/${bytes.length}`);
  await assert.rejects(
    client.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=999-1000' })),
    { name: 'InvalidRange' },
  );
  const copied = await client.send(
    new CopyObjectCommand({
      Bucket,
      Key: 'copy',
      CopySource: `${Bucket}/${encodeURIComponent(Key)}`,
    }),
  );
  assert.ok(copied.CopyObjectResult?.ETag);
  assert.equal(
    (await client.send(new HeadObjectCommand({ Bucket, Key: 'copy' }))).Metadata?.source,
    'local-test',
  );
  await client.send(new PutObjectCommand({ Bucket, Key, Body: 'replacement' }));
  assert.equal(
    await (await client.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString(),
    'replacement',
  );
  await client.send(new DeleteObjectCommand({ Bucket, Key }));
  await client.send(new DeleteObjectCommand({ Bucket, Key }));
  await assert.rejects(client.send(new GetObjectCommand({ Bucket, Key })), { name: 'NoSuchKey' });
});

test('native S3: SDK ListObjects/V2, prefix, delimiter, pagination и DeleteObjects', async (t) => {
  const { client, Bucket } = await fixture(t);
  const keys = ['a.txt', 'media/a.txt', 'media/b.txt', 'media/folder/c.txt', 'z.txt'];
  for (const Key of keys) await client.send(new PutObjectCommand({ Bucket, Key, Body: Key }));
  const legacy = await client.send(
    new ListObjectsCommand({ Bucket, Prefix: 'media/', Delimiter: '/' }),
  );
  assert.deepEqual(
    legacy.Contents?.map((object) => object.Key),
    ['media/a.txt', 'media/b.txt'],
  );
  assert.deepEqual(
    legacy.CommonPrefixes?.map((prefix) => prefix.Prefix),
    ['media/folder/'],
  );
  const page = await client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 2 }));
  assert.equal(page.IsTruncated, true);
  assert.equal(page.KeyCount, 2);
  assert.ok(page.NextContinuationToken);
  const next = await client.send(
    new ListObjectsV2Command({
      Bucket,
      ContinuationToken: page.NextContinuationToken,
      MaxKeys: 10,
    }),
  );
  assert.deepEqual(
    [...page.Contents!, ...next.Contents!].map((object) => object.Key),
    keys,
  );
  assert.equal(next.IsTruncated, false);
  const grouped = await client.send(
    new ListObjectsV2Command({ Bucket, Prefix: 'media/', Delimiter: '/' }),
  );
  assert.deepEqual(
    grouped.Contents?.map((object) => object.Key),
    ['media/a.txt', 'media/b.txt'],
  );
  assert.deepEqual(
    grouped.CommonPrefixes?.map((prefix) => prefix.Prefix),
    ['media/folder/'],
  );
  const deleted = await client.send(
    new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
  );
  assert.equal(deleted.Deleted?.length, keys.length);
  assert.equal((await client.send(new ListObjectsV2Command({ Bucket }))).KeyCount, 0);
});

test('native S3: presigned PUT/GET доступны без Bearer; неверные подписи отвергаются', async (t) => {
  const { client, endpoint, Bucket } = await fixture(t);
  const Key = 'direct/test.txt';
  const bytes = Buffer.from('browser direct bytes');
  const putUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket, Key, Body: bytes, ContentType: 'text/plain' }),
    { expiresIn: 60 },
  );
  const put = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: bytes,
  });
  assert.equal(put.status, 200, await put.text());
  const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), {
    expiresIn: 60,
  });
  const get = await fetch(getUrl);
  assert.equal(get.status, 200);
  assert.equal(await get.text(), bytes.toString());
  const tampered = new URL(getUrl);
  tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
  const badSignature = await fetch(tampered);
  assert.equal(badSignature.status, 403);
  assert.match(await badSignature.text(), /SignatureDoesNotMatch/);
  const unsigned = await fetch(`${endpoint}/${Bucket}/${Key}`);
  assert.equal(unsigned.status, 403);
  assert.match(await unsigned.text(), /AccessDenied/);
  const unknownClient = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { ...credentials, accessKeyId: 'unknown' },
    maxAttempts: 1,
  });
  try {
    await assert.rejects(
      unknownClient.send(new GetObjectCommand({ Bucket, Key })),
      (error: unknown) =>
        error instanceof Error && ['InvalidAccessKeyId', 'AccessDenied'].includes(error.name),
    );
  } finally {
    unknownClient.destroy();
  }
});

test('native S3: стандартный SDK PutObject stream декодируется без aws-chunked framing', async (t) => {
  const { client, Bucket } = await fixture(t);
  const bytes = Buffer.from('streamed object payload\nsecond line');
  await client.send(
    new PutObjectCommand({
      Bucket,
      Key: 'stream.bin',
      Body: Readable.from([bytes.subarray(0, 8), bytes.subarray(8)]),
      ContentLength: bytes.length,
    }),
  );
  const result = await client.send(new GetObjectCommand({ Bucket, Key: 'stream.bin' }));
  assert.deepEqual(Buffer.from(await result.Body!.transformToByteArray()), bytes);
  assert.equal(
    (await client.send(new HeadObjectCommand({ Bucket, Key: 'stream.bin' }))).ContentLength,
    bytes.length,
  );
});

test('native S3: неверная контрольная сумма не заменяет сохранённый объект', async (t) => {
  const { client, Bucket } = await fixture(t);
  const Key = 'integrity.txt';
  await client.send(new PutObjectCommand({ Bucket, Key, Body: 'original' }));
  await assert.rejects(
    client.send(
      new PutObjectCommand({ Bucket, Key, Body: 'corrupted', ChecksumCRC32: 'AAAAAA==' }),
    ),
    { name: 'BadDigest' },
  );
  const result = await client.send(new GetObjectCommand({ Bucket, Key }));
  assert.equal(await result.Body!.transformToString(), 'original');
});

test('native S3: реальный SDK multipart list/complete/abort', async (t) => {
  const { client, Bucket } = await fixture(t);
  const Key = 'multipart/object.bin';
  const initiated = await client.send(
    new CreateMultipartUploadCommand({
      Bucket,
      Key,
      ContentType: 'application/octet-stream',
      Metadata: { mode: 'multipart' },
    }),
  );
  assert.ok(initiated.UploadId);
  const UploadId = initiated.UploadId;
  const pending = await client.send(
    new CreateMultipartUploadCommand({ Bucket, Key: 'zz-pending' }),
  );
  const uploadPage = await client.send(new ListMultipartUploadsCommand({ Bucket, MaxUploads: 1 }));
  assert.equal(uploadPage.IsTruncated, true);
  assert.equal(uploadPage.Uploads?.length, 1);
  assert.equal(uploadPage.Uploads?.[0]?.UploadId, UploadId);
  assert.ok(uploadPage.NextKeyMarker && uploadPage.NextUploadIdMarker);
  const nextUploadPage = await client.send(
    new ListMultipartUploadsCommand({
      Bucket,
      MaxUploads: 1,
      KeyMarker: uploadPage.NextKeyMarker,
      UploadIdMarker: uploadPage.NextUploadIdMarker,
    }),
  );
  assert.equal(nextUploadPage.IsTruncated, false);
  assert.deepEqual(
    nextUploadPage.Uploads?.map((upload) => upload.UploadId),
    [pending.UploadId],
  );
  await client.send(
    new AbortMultipartUploadCommand({ Bucket, Key: 'zz-pending', UploadId: pending.UploadId }),
  );
  const firstBytes = Buffer.alloc(5 * 1024 * 1024, 'a');
  const lastBytes = Buffer.from('last-part');
  const first = await client.send(
    new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 1, Body: firstBytes }),
  );
  const last = await client.send(
    new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 2, Body: lastBytes }),
  );
  assert.ok(first.ETag && last.ETag);
  assert.ok(
    (await client.send(new ListMultipartUploadsCommand({ Bucket }))).Uploads?.some(
      (upload) => upload.UploadId === UploadId,
    ),
  );
  const parts = await client.send(new ListPartsCommand({ Bucket, Key, UploadId }));
  assert.deepEqual(
    parts.Parts?.map((part) => part.PartNumber),
    [1, 2],
  );
  const complete = await client.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key,
      UploadId,
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: first.ETag },
          { PartNumber: 2, ETag: last.ETag },
        ],
      },
    }),
  );
  assert.match(complete.ETag ?? '', /-2"?$/);
  const result = await client.send(new GetObjectCommand({ Bucket, Key }));
  assert.deepEqual(
    Buffer.from(await result.Body!.transformToByteArray()),
    Buffer.concat([firstBytes, lastBytes]),
  );
  assert.deepEqual((await client.send(new HeadObjectCommand({ Bucket, Key }))).Metadata, {
    mode: 'multipart',
  });
  await assert.rejects(client.send(new ListPartsCommand({ Bucket, Key, UploadId })), {
    name: 'NoSuchUpload',
  });
  const aborted = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: 'aborted' }));
  await client.send(
    new AbortMultipartUploadCommand({ Bucket, Key: 'aborted', UploadId: aborted.UploadId }),
  );
  await assert.rejects(
    client.send(new ListPartsCommand({ Bucket, Key: 'aborted', UploadId: aborted.UploadId })),
    { name: 'NoSuchUpload' },
  );
  await assert.rejects(client.send(new GetObjectCommand({ Bucket, Key: 'aborted' })), {
    name: 'NoSuchKey',
  });
});

test('native S3: неподдерживаемая операция не выдаётся за успех', async (t) => {
  const { client, Bucket } = await fixture(t);
  await assert.rejects(
    client.send(
      new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }),
    ),
    { name: 'NotImplemented' },
  );
});

test('native S3: UploadPartCopy копирует Range в multipart через реальный SDK', async (t) => {
  const { client, Bucket } = await fixture(t);
  await client.send(new PutObjectCommand({ Bucket, Key: 'source', Body: '0123456789' }));
  const Key = 'copied-part';
  const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket, Key }));
  const copied = await client.send(
    new UploadPartCopyCommand({
      Bucket,
      Key,
      UploadId,
      PartNumber: 1,
      CopySource: `${Bucket}/source`,
      CopySourceRange: 'bytes=2-6',
    }),
  );
  assert.ok(copied.CopyPartResult?.ETag);
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key,
      UploadId,
      MultipartUpload: { Parts: [{ PartNumber: 1, ETag: copied.CopyPartResult.ETag }] },
    }),
  );
  const result = await client.send(new GetObjectCommand({ Bucket, Key }));
  assert.equal(await result.Body!.transformToString(), '23456');
});
