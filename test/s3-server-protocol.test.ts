import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';
import { checkedBody, objectMetadata, readXml } from '../src/modules/s3/presentation/protocol.js';
import { S3Error } from '../src/modules/s3/domain/s3-error.js';

const url = new URL('http://localhost:9011/bucket/key');
function request(bytes: Buffer[], headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = headers;
  req[Symbol.asyncIterator] = async function* () {
    for (const chunk of bytes) yield chunk;
    return undefined;
  };
  return req;
}
const errorCode = (code: string) => (error: unknown) =>
  error instanceof S3Error && error.code === code;
async function decode(req: IncomingMessage, payloadHash = 'STREAMING-UNSIGNED-PAYLOAD-TRAILER') {
  const metadata = {};
  const body = checkedBody(req, url, payloadHash, metadata);
  const chunks: Buffer[] = [];
  for await (const bytes of body.stream) chunks.push(Buffer.from(bytes));
  await body.options.validate!();
  return { bytes: Buffer.concat(chunks), metadata };
}
const streamingHeaders = {
  'content-encoding': 'aws-chunked',
  'x-amz-trailer': 'x-amz-checksum-crc32',
  'x-amz-decoded-content-length': '5',
};
const envelope = Buffer.from('2\r\nhe\r\n3\r\nllo\r\n0\r\nx-amz-checksum-crc32:NhCmhg==\r\n\r\n');

test('S3 unsigned streaming decodes arbitrary framing fragments and validates CRC32 trailer', async () => {
  const result = await decode(
    request(
      Array.from(envelope, (byte) => Buffer.from([byte])),
      streamingHeaders,
    ),
  );
  assert.equal(result.bytes.toString(), 'hello');
  assert.deepEqual(result.metadata, { checksums: { crc32: 'NhCmhg==' } });
});

test('S3 streaming rejects oversized lines, missing or conflicting trailers and trailing data', async () => {
  await assert.rejects(
    decode(request([Buffer.from('0'.repeat(9000) + '\r\n')], streamingHeaders)),
    errorCode('InvalidRequest'),
  );
  await assert.rejects(
    decode(request([Buffer.from('5\r\nhello\r\n0\r\n\r\n')], streamingHeaders)),
    errorCode('BadDigest'),
  );
  await assert.rejects(
    decode(request([Buffer.concat([envelope, Buffer.from('extra')])], streamingHeaders)),
    errorCode('InvalidRequest'),
  );
  await assert.rejects(
    decode(
      request([Buffer.from(envelope.toString().replace('NhCmhg==', 'AAAAAA=='))], {
        ...streamingHeaders,
        'x-amz-checksum-crc32': 'NhCmhg==',
      }),
    ),
    errorCode('BadDigest'),
  );
  await assert.rejects(
    decode(
      request([envelope], {
        ...streamingHeaders,
        'x-amz-trailer': 'x-amz-checksum-crc32,x-amz-checksum-crc32',
      }),
    ),
    errorCode('InvalidRequest'),
  );
});

test('S3 checked body validates Content-MD5 and SHA256 payload integrity', async () => {
  const bytes = Buffer.from('hello');
  const payloadHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.equal(
    (
      await decode(request([bytes], { 'content-md5': 'XUFAKrxLKna5cZ2REBfFkg==' }), payloadHash)
    ).bytes.toString(),
    'hello',
  );
  await assert.rejects(
    decode(request([bytes], { 'content-md5': 'AAAAAAAAAAAAAAAAAAAAAA==' }), payloadHash),
    errorCode('BadDigest'),
  );
  await assert.rejects(
    decode(request([Buffer.from('changed')]), payloadHash),
    errorCode('XAmzContentSHA256Mismatch'),
  );
});

test('S3 object metadata rejects unsafe response headers before storing and counts actual key/value bytes', () => {
  const valid = new URL(url);
  valid.searchParams.set('x-amz-meta-key', 'v'.repeat(2045));
  assert.equal(objectMetadata(request([]), valid).metadata?.key?.length, 2045);
  valid.searchParams.set('x-amz-meta-key', 'v'.repeat(2046));
  assert.throws(() => objectMetadata(request([]), valid), errorCode('MetadataTooLarge'));
  const prototype = new URL(url);
  prototype.searchParams.set('x-amz-meta-__proto__', 'safe');
  assert.equal(objectMetadata(request([]), prototype).metadata?.['__proto__'], 'safe');
  for (const [name, value] of [
    ['x-amz-meta-source', 'one\r\ntwo'],
    ['content-type', 'text/\u0000plain'],
    ['content-disposition', 'файл.txt'],
    ['x-amz-meta-bad name', 'value'],
  ]) {
    const invalid = new URL(url);
    invalid.searchParams.set(name!, value!);
    assert.throws(() => objectMetadata(request([]), invalid), errorCode('InvalidArgument'));
  }
});

test('S3 XML validates UTF8, decoded length, malformed XML and entity declarations', async () => {
  const valid = Buffer.from('<Delete><Object><Key>a&amp;b</Key></Object></Delete>');
  assert.deepEqual(await readXml(request([valid]), url, 'UNSIGNED-PAYLOAD'), {
    Delete: { Object: [{ Key: 'a&b' }] },
  });
  await assert.rejects(
    readXml(
      request([valid], { 'content-length': String(valid.length + 1) }),
      url,
      'UNSIGNED-PAYLOAD',
    ),
    errorCode('IncompleteBody'),
  );
  await assert.rejects(
    readXml(request([Buffer.from([0xff])]), url, 'UNSIGNED-PAYLOAD'),
    errorCode('MalformedXML'),
  );
  for (const text of ['<Delete>', '<!DOCTYPE Delete [<!ENTITY x "bad">]><Delete>&x;</Delete>']) {
    await assert.rejects(
      readXml(request([Buffer.from(text)]), url, 'UNSIGNED-PAYLOAD'),
      errorCode('MalformedXML'),
    );
  }
});
