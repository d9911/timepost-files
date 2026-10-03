import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Storage } from '../src/modules/files/infrastructure/storage/s3-storage.js';
const environment = {
  S3_BUCKET: 'timepost-files',
  S3_REGION: 'us-east-1',
  S3_ENDPOINT: 'https://storage.example.test',
  S3_ACCESS_KEY_ID: 'test-access',
  S3_SECRET_ACCESS_KEY: 'test-secret',
};
test('S3 требует конфигурацию и запрещает небезопасные адреса облака', () => {
  assert.throws(() => new S3Storage({}), /S3_BUCKET/);
  assert.throws(() => new S3Storage({ ...environment, S3_SECRET_ACCESS_KEY: '' }), /оба S3/);
  for (const endpoint of [
    'http://storage.example.test',
    'https://user:secret@storage.example.test',
    'https://storage.example.test/path',
    'https://storage.example.test?key=secret',
  ])
    assert.throws(
      () =>
        new S3Storage({ ...environment, S3_ENDPOINT: endpoint, S3_ALLOW_INSECURE_LOCAL: 'true' }),
    );
});
test('локальный HTTP включается явно, ID объектов не допускают обхода пути', () => {
  assert.throws(() => new S3Storage({ ...environment, S3_ENDPOINT: 'http://s3mock:9090' }));
  const storage = new S3Storage({
    ...environment,
    S3_ENDPOINT: 'http://s3mock:9090',
    S3_ALLOW_INSECURE_LOCAL: 'true',
  });
  assert.equal(
    storage.key('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    'timepost/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  assert.throws(() => storage.key('../other-file'));
  storage.client.destroy();
});
test('провайдеры имеют отдельную идентичность, AWS допускает стандартную цепочку credentials', () => {
  for (const provider of ['selectel', 'aws', 'yandex-object'] as const) {
    const storage = new S3Storage(environment, provider);
    assert.equal(storage.provider, provider);
    storage.client.destroy();
  }
  const aws = new S3Storage({ S3_BUCKET: 'timepost-files', S3_REGION: 'eu-central-1' }, 'aws');
  assert.equal(aws.provider, 'aws');
  aws.client.destroy();
});

test('готовность отклоняет бакет с включённой историей версий', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/xml');
    response.end(
      request.method === 'HEAD'
        ? ''
        : '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const storage = new S3Storage({
    ...environment,
    S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
    S3_ALLOW_INSECURE_LOCAL: 'true',
  });
  try {
    await assert.rejects(storage.ready(), /бакет без истории версий/);
  } finally {
    storage.client.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
