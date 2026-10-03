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
  assert.throws(
    () => new S3Storage({ ...environment, YANDEX_IAM_TOKEN: 'test-token' }, 'aws'),
    /только/,
  );
  assert.throws(
    () => new S3Storage({ ...environment, YANDEX_IAM_TOKEN: 'test-token' }, 'yandex-object'),
    /не оба/,
  );
  assert.throws(
    () =>
      new S3Storage(
        { S3_BUCKET: 'timepost-files', YANDEX_IAM_TOKEN: 'bad\ntoken' },
        'yandex-object',
      ),
    /Неверный/,
  );
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
test('провайдеры имеют отдельную идентичность, AWS допускает стандартную цепочку credentials', async () => {
  for (const provider of ['selectel', 'aws', 'yandex-object'] as const) {
    const storage = new S3Storage(environment, provider);
    assert.equal(storage.provider, provider);
    storage.client.destroy();
  }
  const aws = new S3Storage({ S3_BUCKET: 'timepost-files', S3_REGION: 'eu-central-1' }, 'aws');
  assert.equal(aws.provider, 'aws');
  aws.client.destroy();
  const yandex = new S3Storage(
    { S3_BUCKET: 'timepost-files', YANDEX_IAM_TOKEN: 'test-token' },
    'yandex-object',
  );
  assert.equal(await yandex.client.config.region(), 'ru-central1');
  yandex.client.destroy();
});

test('S3 HTTP: AWS SigV4 и Yandex IAM используют одинаковые операции и байты', async () => {
  const { createServer } = await import('node:http');
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const bytes = Buffer.from('private object');
  for (const mode of ['sigv4', 'iam'] as const) {
    const requests: {
      method: string;
      url: string;
      authorization: string;
      contentType?: string;
      condition?: string;
      md5?: string | string[];
    }[] = [];
    let uploaded = Buffer.alloc(0);
    const server = createServer(async (request, response) => {
      requests.push({
        method: request.method!,
        url: request.url!,
        authorization: request.headers.authorization ?? '',
        contentType: request.headers['content-type'],
        condition: request.headers['if-none-match'],
        md5: request.headers['content-md5'],
      });
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        response.setHeader('ETag', '"test-etag"');
        response.end();
      } else if (request.method === 'GET' && request.url?.includes('versioning')) {
        response.setHeader('Content-Type', 'application/xml');
        response.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
      } else if (request.method === 'GET') {
        response.setHeader('Content-Length', uploaded.length);
        response.end(uploaded);
      } else {
        response.statusCode = request.method === 'DELETE' ? 204 : 200;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const storage = new S3Storage(
      {
        S3_BUCKET: environment.S3_BUCKET,
        S3_REGION: 'ru-central1',
        S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
        S3_ALLOW_INSECURE_LOCAL: 'true',
        ...(mode === 'iam'
          ? { YANDEX_IAM_TOKEN: 'test-iam-token' }
          : { S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret' }),
      },
      mode === 'iam' ? 'yandex-object' : 'aws',
    );
    try {
      await storage.ready();
      await storage.upload(id, bytes, 'application/octet-stream');
      const chunks = [];
      for await (const chunk of await storage.download(id)) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), bytes);
      await storage.delete(id);
      assert.deepEqual(
        requests.map(({ method }) => method),
        ['HEAD', 'GET', 'PUT', 'GET', 'HEAD', 'GET', 'DELETE'],
      );
      for (const request of requests) {
        if (mode === 'iam') assert.equal(request.authorization, 'Bearer test-iam-token');
        else
          assert.match(
            request.authorization,
            /^AWS4-HMAC-SHA256 Credential=test-access\/.+\/ru-central1\/s3\/aws4_request,/,
          );
      }
      const put = requests.find(({ method }) => method === 'PUT')!;
      assert.equal(put.url, `/timepost-files/timepost/${id}?x-id=PutObject`);
      assert.equal(put.condition, '*');
      assert.equal(put.contentType, 'application/octet-stream');
      assert.equal(put.md5, 'mmLTUSx9wWAYC/Z8zn3rGg==');
    } finally {
      storage.client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
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
