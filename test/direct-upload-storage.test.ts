import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Storage } from '../src/modules/files/infrastructure/storage/s3-storage.js';
import {
  UploadPartCopyCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
const environment = {
  S3_BUCKET: 'test-media',
  S3_ACCESS_KEY_ID: 'test-access',
  S3_SECRET_ACCESS_KEY: 'test-secret',
};

test('direct PUT and GET links use Yandex SigV4, signed constraints and metadata', async () => {
  const storage = new S3Storage(environment, 'yandex-object');
  try {
    const url = new URL(
      await storage.presignPut(
        'incoming/user/project/upload/original.mp4',
        'video/mp4',
        42,
        { 'upload-id': 'upload' },
        300,
      ),
    );
    assert.equal(url.hostname, 'storage.yandexcloud.net');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.match(url.searchParams.get('X-Amz-Credential')!, /\/ru-central1\/s3\/aws4_request$/);
    assert.match(url.searchParams.get('X-Amz-SignedHeaders')!, /content-length/);
    assert.match(url.searchParams.get('X-Amz-SignedHeaders')!, /content-type/);
    assert.match(url.searchParams.get('X-Amz-SignedHeaders')!, /if-none-match/);
    assert.equal(url.searchParams.get('x-amz-meta-upload-id'), 'upload');
    const get = new URL(
      await storage.presignGet('media/user/project/media/original.mp4', 'видео.mp4', 60),
    );
    assert.match(get.searchParams.get('response-content-disposition')!, /UTF-8''/);
    await assert.rejects(storage.presignGet('../other', 'x', 60));
  } finally {
    storage.client.destroy();
  }
});

test('IAM legacy mode cannot issue presigned permissions', async () => {
  const storage = new S3Storage(
    { S3_BUCKET: 'test-media', YANDEX_IAM_TOKEN: 'test-iam' },
    'yandex-object',
  );
  try {
    await assert.rejects(storage.presignGet('media/a/b/c/original.mp4', 'x', 60), /статические/);
  } finally {
    storage.client.destroy();
  }
});

test('10 GB promotion copies bounded ranges with ETag preconditions and aborts failures', async () => {
  const storage = new S3Storage(environment, 'yandex-object');
  const commands: unknown[] = [];
  const size = 10_000_000_000;
  // Public adapter behavior at its real SDK seam: no object bytes are supplied.
  storage.client.send = (async (command: unknown) => {
    commands.push(command);
    const name = (command as object).constructor.name;
    if (name === 'HeadObjectCommand')
      return { ContentLength: size, ETag: '"source"', ContentType: 'video/mp4', Metadata: {} };
    if (name === 'CreateMultipartUploadCommand') return { UploadId: 'copy-upload' };
    if (name === 'UploadPartCopyCommand') return { CopyPartResult: { ETag: '"part"' } };
    return {};
  }) as typeof storage.client.send;
  try {
    await storage.promoteObject(
      'incoming/a/b/c/original.mp4',
      'media/a/b/c/original.mp4',
      size,
      '"source"',
    );
    const copies = commands.filter(
      (command): command is UploadPartCopyCommand => command instanceof UploadPartCopyCommand,
    );
    assert.equal(copies.length, Math.ceil(size / (256 * 1024 * 1024)));
    assert.equal(copies[0]!.input.CopySourceRange, 'bytes=0-268435455');
    assert.equal(copies.at(-1)!.input.CopySourceRange?.split('-').at(-1), String(size - 1));
    assert.ok(copies.every((command) => command.input.CopySourceIfMatch === '"source"'));
    assert.ok(commands.some((command) => command instanceof CompleteMultipartUploadCommand));
    commands.length = 0;
    storage.client.send = (async (command: unknown) => {
      commands.push(command);
      const name = (command as object).constructor.name;
      if (name === 'HeadObjectCommand')
        return { ContentLength: size, ETag: '"source"', ContentType: 'video/mp4' };
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'failed-upload' };
      if (command instanceof UploadPartCopyCommand) throw new Error('copy failure');
      return {};
    }) as typeof storage.client.send;
    await assert.rejects(
      storage.promoteObject(
        'incoming/a/b/c/original.mp4',
        'media/a/b/c/original.mp4',
        size,
        '"source"',
      ),
      /copy failure/,
    );
    assert.ok(commands.some((command) => command instanceof AbortMultipartUploadCommand));
  } finally {
    storage.client.destroy();
  }
});

test('listParts follows S3 pagination and rejects repeated markers', async () => {
  const storage = new S3Storage(environment, 'yandex-object');
  storage.client.send = (async (command: ListPartsCommand) =>
    command.input.PartNumberMarker
      ? { Parts: [{ PartNumber: 2, Size: 5, ETag: 'two' }] }
      : {
          Parts: [{ PartNumber: 1, Size: 8, ETag: 'one' }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        }) as typeof storage.client.send;
  try {
    assert.deepEqual(await storage.listParts('incoming/a/b/c/original.mp4', 'upload'), [
      { partNumber: 1, sizeBytes: 8, etag: 'one' },
      { partNumber: 2, sizeBytes: 5, etag: 'two' },
    ]);
    storage.client.send = (async () => ({
      IsTruncated: true,
      NextPartNumberMarker: '1',
      Parts: [],
    })) as typeof storage.client.send;
    await assert.rejects(storage.listParts('incoming/a/b/c/original.mp4', 'upload'), /пагинацию/);
  } finally {
    storage.client.destroy();
  }
});
