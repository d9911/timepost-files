import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStore } from '../src/modules/s3/infrastructure/local-object-store.js';

async function* bytes(value: string | Buffer) {
  yield Buffer.from(value);
}
async function content(stream: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
async function setup(t: TestContext, max?: number) {
  const path = await mkdtemp(join(tmpdir(), 'files-s3-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new LocalObjectStore(path, max);
  await store.initialize();
  await store.createBucket('test-bucket');
  return { store, path };
}
test('local S3 persists arbitrary keys and atomic overwrite across restart', async (t) => {
  const { store, path } = await setup(t);
  const key = '../../outside/é file';
  const first = await store.putObject('test-bucket', key, bytes('hello'), {
    metadata: { owner: 'denis' },
  });
  assert.equal(first.etag, '"5d41402abc4b2a76b9719d911017c592"');
  const reader = await store.getObject('test-bucket', key);
  await store.putObject('test-bucket', key, bytes('world'), {});
  assert.equal(await content(reader.stream), 'hello');
  const restarted = new LocalObjectStore(path);
  assert.equal(await content((await restarted.getObject('test-bucket', key)).stream), 'world');
  assert.equal(
    await content((await restarted.getObject('test-bucket', key, { start: 1, end: 3 })).stream),
    'orl',
  );
  await assert.rejects(store.deleteBucket('test-bucket'), /not empty/);
  await store.deleteObject('test-bucket', key);
  await store.deleteObject('test-bucket', key);
  await store.deleteBucket('test-bucket');
  assert.deepEqual(await store.listBuckets(), []);
});
test('failed body size checksum and trailer validation preserve committed data', async (t) => {
  const { store } = await setup(t, 10);
  await store.putObject('test-bucket', 'key', bytes('hello'), {});
  await assert.rejects(
    store.putObject('test-bucket', 'key', bytes('world'), {}, { expectedSize: 9 }),
    /Content-Length/,
  );
  await assert.rejects(
    store.putObject('test-bucket', 'key', bytes('world'), {}, { expectedSha256: '0'.repeat(64) }),
    /checksum/,
  );
  await assert.rejects(
    store.putObject(
      'test-bucket',
      'key',
      bytes('world'),
      {},
      {
        validate: async () => {
          throw new Error('bad trailer');
        },
      },
    ),
    /bad trailer/,
  );
  await assert.rejects(
    store.putObject('test-bucket', 'key', bytes('x'.repeat(11)), {}),
    /size limit/,
  );
  assert.equal(await content((await store.getObject('test-bucket', 'key')).stream), 'hello');
});
test('conditional writes serialize concurrent creation and protect existing objects', async (t) => {
  const { store } = await setup(t);
  const results = await Promise.allSettled([
    store.putObject('test-bucket', 'key', bytes('one'), {}, { ifNoneMatch: '*' }),
    store.putObject('test-bucket', 'key', bytes('two'), {}, { ifNoneMatch: '*' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const old = await store.headObject('test-bucket', 'key');
  await assert.rejects(
    store.putObject('test-bucket', 'key', bytes('new'), {}, { ifMatch: '"wrong"' }),
    /precondition/,
  );
  await store.putObject('test-bucket', 'key', bytes('new'), {}, { ifMatch: old.etag });
  assert.equal(await content((await store.getObject('test-bucket', 'key')).stream), 'new');
});
test('prefix delimiter and pagination enumerate keys without filesystem traversal', async (t) => {
  const { store } = await setup(t);
  for (const key of ['a/a', 'a/b', 'b', 'c'])
    await store.putObject('test-bucket', key, bytes(key), {});
  const first = await store.listObjects('test-bucket', { delimiter: '/', maxKeys: 1 });
  assert.deepEqual(first.commonPrefixes, ['a/']);
  assert.equal(first.isTruncated, true);
  const next = await store.listObjects('test-bucket', {
    delimiter: '/',
    continuationToken: first.nextContinuationToken,
  });
  assert.deepEqual(
    next.objects.map((o) => o.key),
    ['b', 'c'],
  );
  assert.deepEqual(
    (await store.listObjects('test-bucket', { prefix: 'a/' })).objects.map((o) => o.key),
    ['a/a', 'a/b'],
  );
});
test('multipart enforces order minimum part size and preserves resumable uploads across restart', async (t) => {
  const { store, path } = await setup(t);
  const id = await store.initiateMultipart('test-bucket', 'large', { contentType: 'text/plain' });
  const first = await store.uploadPart(
    'test-bucket',
    'large',
    id,
    1,
    bytes(Buffer.alloc(5 * 1024 ** 2, 97)),
  );
  const last = await store.uploadPart('test-bucket', 'large', id, 2, bytes('end'));
  const restarted = new LocalObjectStore(path);
  assert.equal((await restarted.listParts('test-bucket', 'large', id)).length, 2);
  await assert.rejects(
    restarted.completeMultipart('test-bucket', 'large', id, [last, first]),
    /ordered/,
  );
  const object = await restarted.completeMultipart('test-bucket', 'large', id, [first, last]);
  assert.equal(object.sizeBytes, 5 * 1024 ** 2 + 3);
  assert.match(object.etag, /^"[a-f0-9]{32}-2"$/);
  assert.equal(
    await content(
      (
        await restarted.getObject('test-bucket', 'large', {
          start: object.sizeBytes - 3,
          end: object.sizeBytes - 1,
        })
      ).stream,
    ),
    'end',
  );
  assert.deepEqual(await restarted.listMultipart('test-bucket'), []);
  const small = await store.initiateMultipart('test-bucket', 'small', {});
  const p1 = await store.uploadPart('test-bucket', 'small', small, 1, bytes('a'));
  const p2 = await store.uploadPart('test-bucket', 'small', small, 2, bytes('b'));
  await assert.rejects(
    store.completeMultipart('test-bucket', 'small', small, [p1, p2]),
    /at least 5 MiB/,
  );
  await store.abortMultipart('test-bucket', 'small', small);
});
test('refuses symlink storage roots and bucket directories', async (t) => {
  const { store, path } = await setup(t);
  await symlink(join(path, 'test-bucket'), join(path, 'evil-bucket'));
  await assert.rejects(store.headBucket('evil-bucket'), /Unsafe bucket/);
  const linked = `${path}-link`;
  await symlink(path, linked);
  t.after(() => rm(linked, { force: true }));
  await assert.rejects(new LocalObjectStore(linked).initialize(), /Unsafe storage/);
});

test('copy preserves data metadata and rejects a mismatched source ETag', async (t) => {
  const { store } = await setup(t);
  const source = await store.putObject('test-bucket', 'source', bytes('copy me'), {
    contentType: 'text/plain',
    metadata: { author: 'denis' },
  });
  await assert.rejects(
    store.copyObject('test-bucket', 'source', 'test-bucket', 'target', undefined, '"wrong"'),
    /precondition/,
  );
  const copy = await store.copyObject(
    'test-bucket',
    'source',
    'test-bucket',
    'target',
    undefined,
    source.etag,
  );
  assert.equal(copy.etag, source.etag);
  assert.deepEqual(copy.metadata, source.metadata);
  assert.equal(await content((await store.getObject('test-bucket', 'target')).stream), 'copy me');
});
