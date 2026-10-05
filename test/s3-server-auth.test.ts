import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authenticateS3 } from '../src/modules/s3/infrastructure/sigv4.js';
import { S3Error } from '../src/modules/s3/domain/s3-error.js';

const date = new Date('2013-05-24T00:00:00Z');
const options = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  now: () => date,
};
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const goldenUrl =
  'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';

function request(url: URL, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  const result = new IncomingMessage(new Socket());
  result.method = method;
  result.url = `${url.pathname}${url.search}`;
  result.headers = { host: url.host, ...headers };
  result.rawHeaders = Object.entries(result.headers).flatMap(([name, value]) => [
    name,
    String(value),
  ]);
  return result;
}

function rejects(url: URL, req: IncomingMessage, code: string, override = options): void {
  assert.throws(
    () => authenticateS3(req, url, override),
    (error: unknown) => error instanceof S3Error && error.code === code,
  );
}

// Independent fixtures published by AWS, rather than signatures calculated by the verifier:
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-query-string-auth.html
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
test('S3 SigV4 accepts the official AWS presigned GET example', () => {
  const url = new URL(goldenUrl);
  assert.deepEqual(authenticateS3(request(url), url, options), {
    payloadHash: 'UNSIGNED-PAYLOAD',
    principal: options.accessKeyId,
  });
});

test('S3 SigV4 accepts the official AWS header-signed ranged GET example', () => {
  const url = new URL('https://examplebucket.s3.amazonaws.com/test.txt');
  const req = request(url, 'GET', {
    range: 'bytes=0-9',
    'x-amz-content-sha256': emptyHash,
    'x-amz-date': '20130524T000000Z',
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  });
  assert.equal(authenticateS3(req, url, options).payloadHash, emptyHash);
  rejects(url, req, 'RequestTimeTooSkewed', {
    ...options,
    now: () => new Date(date.getTime() + 901_000),
  });
});

test('S3 SigV4 binds method, original path, query and host to the signature', () => {
  for (const mutate of [
    (req: IncomingMessage) => {
      req.method = 'PUT';
    },
    (req: IncomingMessage) => {
      req.url = req.url!.replace('/test.txt', '/other.txt');
    },
    (_req: IncomingMessage, url: URL) => {
      url.searchParams.append('response-content-type', 'text/plain');
    },
    (_req: IncomingMessage, url: URL) => {
      url.searchParams.set('X-Amz-Date', '20130524T000001Z');
    },
    (_req: IncomingMessage, url: URL) => {
      url.searchParams.set('X-Amz-Expires', '86401');
    },
    (req: IncomingMessage) => {
      req.headers.host = 'localhost:9000';
    },
  ]) {
    const url = new URL(goldenUrl);
    const req = request(url);
    mutate(req, url);
    rejects(url, req, 'SignatureDoesNotMatch');
  }
});

test('S3 SigV4 rejects expiry, invalid dates, scope, duplicate authentication and unsigned access', () => {
  const url = new URL(goldenUrl);
  rejects(url, request(url), 'AccessDenied', {
    ...options,
    now: () => new Date(date.getTime() + 86_400_001),
  });
  rejects(url, request(url), 'RequestTimeTooSkewed', {
    ...options,
    now: () => new Date(date.getTime() - 901_000),
  });
  for (const [name, value, code] of [
    ['X-Amz-Expires', '604801', 'InvalidRequest'],
    ['X-Amz-Expires', '0', 'InvalidRequest'],
    ['X-Amz-Date', '20130524T996000Z', 'InvalidRequest'],
    [
      'X-Amz-Credential',
      `${options.accessKeyId}/20130524/ru-central1/s3/aws4_request`,
      'AuthorizationHeaderMalformed',
    ],
    [
      'X-Amz-Credential',
      `${options.accessKeyId}/20130524/us-east-1/ec2/aws4_request`,
      'AuthorizationHeaderMalformed',
    ],
    ['X-Amz-Credential', 'other/20130524/us-east-1/s3/aws4_request', 'InvalidAccessKeyId'],
    ['X-Amz-SignedHeaders', 'host;host', 'InvalidRequest'],
    ['X-Amz-SignedHeaders', 'Host', 'InvalidRequest'],
    ['X-Amz-SignedHeaders', 'x-amz-date;host', 'InvalidRequest'],
    ['X-Amz-Security-Token', 'temporary', 'NotImplemented'],
  ]) {
    const mutated = new URL(goldenUrl);
    mutated.searchParams.set(name!, value!);
    rejects(mutated, request(mutated), code!);
  }
  const duplicate = new URL(goldenUrl);
  duplicate.searchParams.append('X-Amz-Expires', '1');
  rejects(duplicate, request(duplicate), 'InvalidRequest');
  const plain = new URL('http://localhost:9000/bucket/key');
  rejects(plain, request(plain), 'AccessDenied');
  rejects(url, request(url, 'GET', { authorization: 'Bearer wrong' }), 'InvalidRequest');
  const duplicateHeader = request(url);
  duplicateHeader.rawHeaders.push('Host', url.host);
  rejects(url, duplicateHeader, 'InvalidRequest');
  rejects(url, request(url, 'GET', { 'x-amz-copy-source': '/private/secret' }), 'InvalidRequest');
  rejects(
    url,
    request(url, 'GET', { 'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' }),
    'NotImplemented',
  );
});

test('S3 SigV4 authenticates current AWS SDK presigned URLs with Unicode, slashes and response query', async () => {
  const client = new S3Client({
    endpoint: 'http://localhost:9011',
    region: options.region,
    forcePathStyle: true,
    credentials: options,
  });
  try {
    const url = new URL(
      await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: 'media',
          Key: "nested//файл !'()*.txt",
          ResponseContentDisposition: 'attachment; filename="файл.txt"',
        }),
        { signingDate: date, expiresIn: 600 },
      ),
    );
    assert.equal(authenticateS3(request(url), url, options).principal, options.accessKeyId);
  } finally {
    client.destroy();
  }
});

test('S3 SigV4 authenticates a real AWS SDK signed PUT without cloud access', async () => {
  let verified = false;
  const client = new S3Client({
    endpoint: 'http://localhost:9011',
    region: options.region,
    forcePathStyle: true,
    credentials: options,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    requestHandler: {
      handle: async (input: {
        method: string;
        path: string;
        headers: Record<string, string>;
        query?: Record<string, string | string[]>;
      }) => {
        const url = new URL(`http://localhost:9011${input.path}`);
        for (const [name, value] of Object.entries(input.query ?? {})) {
          for (const item of Array.isArray(value) ? value : [value])
            url.searchParams.append(name, item);
        }
        const req = request(url, input.method, input.headers);
        req.url = `${input.path}${url.search}`;
        const result = authenticateS3(req, url, {
          ...options,
          now: () => new Date(),
        });
        assert.equal(result.principal, options.accessKeyId);
        assert.match(result.payloadHash, /^[a-f0-9]{64}$/);
        verified = true;
        return {
          response: { statusCode: 200, headers: { etag: '"test-etag"' }, body: Readable.from([]) },
        };
      },
    },
  });
  client.middlewareStack.add(
    (next) => async (args) => {
      const outgoing = args.request as { query: Record<string, string | string[]> };
      outgoing.query['filter'] = ['z', 'a'];
      outgoing.query['special'] = " !'()*";
      return next(args);
    },
    { step: 'build', name: 'authenticationQueryFixture' },
  );
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: 'media',
        Key: 'folder//./nested/../text.txt',
        Body: 'hello',
        ContentType: 'text/plain',
      }),
    );
    assert.equal(verified, true);
  } finally {
    client.destroy();
  }
});
