import { createHash } from 'node:crypto';
import { validateHeaderName, validateHeaderValue, type IncomingMessage } from 'node:http';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { S3Error } from '../domain/s3-error.js';
import type {
  StoredObjectInput,
  ObjectWriteOptions,
} from '../infrastructure/local-object-store.js';
export const xml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
export const tag = (name: string, value: unknown) => `<${name}>${xml(value)}</${name}>`;
export const document = (name: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><${name} xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</${name}>`;
export const field = (req: IncomingMessage, url: URL, name: string): string | undefined => {
  const header = req.headers[name];
  if (Array.isArray(header)) throw new S3Error('InvalidRequest', 'Duplicate header', 400);
  const query = url.searchParams.getAll(name);
  if (query.length > 1 || (header && query.length && header !== query[0]))
    throw new S3Error('InvalidRequest', 'Conflicting parameters', 400);
  return header ?? query[0];
};
export function integer(
  value: string | null | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
    throw new S3Error('InvalidArgument', 'Invalid numeric parameter', 400);
  return Number(value);
}
function headerValue(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    validateHeaderName(name);
    validateHeaderValue(name, value);
  } catch {
    throw new S3Error('InvalidArgument', 'Invalid object metadata header', 400);
  }
  return value;
}
export function objectMetadata(req: IncomingMessage, url: URL): StoredObjectInput {
  const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of new Set([...Object.keys(req.headers), ...url.searchParams.keys()])) {
    if (name.startsWith('x-amz-meta-')) {
      if (name.length === 11) throw new S3Error('InvalidArgument', 'Empty metadata name', 400);
      metadata[name.slice(11)] = headerValue(name, field(req, url, name))!;
    }
  }
  if (
    Object.entries(metadata).reduce(
      (size, [name, value]) => size + Buffer.byteLength(name) + Buffer.byteLength(value),
      0,
    ) > 2048
  )
    throw new S3Error('MetadataTooLarge', 'Metadata exceeds 2 KiB', 400);
  const contentEncoding = headerValue('content-encoding', field(req, url, 'content-encoding'))
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== 'aws-chunked')
    .join(',');
  return {
    contentType:
      headerValue('content-type', field(req, url, 'content-type')) ?? 'application/octet-stream',
    metadata,
    contentEncoding: contentEncoding || undefined,
    cacheControl: headerValue('cache-control', field(req, url, 'cache-control')),
    contentDisposition: headerValue('content-disposition', field(req, url, 'content-disposition')),
  };
}
const checksumNames = ['crc32', 'crc32c', 'sha1', 'sha256'] as const;
function crcTable(polynomial: number): Uint32Array {
  return Uint32Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? polynomial ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
}
const crc32 = crcTable(0xedb88320),
  crc32c = crcTable(0x82f63b78);
function crcBase64(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE((value ^ 0xffffffff) >>> 0);
  return buffer.toString('base64');
}
/** Decode the unsigned AWS chunk envelope used by current SDK stream uploads.
 * HTTP transfer chunk framing has already been decoded by Node. */
async function* awsChunks(
  source: AsyncIterable<Uint8Array>,
  trailers: Record<string, string>,
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  async function pull() {
    const next = await iterator.next();
    if (next.done) throw new S3Error('IncompleteBody', 'Truncated chunked body', 400);
    pending = Buffer.concat([pending, Buffer.from(next.value)]);
  }
  async function line() {
    while (true) {
      const end = pending.indexOf('\r\n');
      if (end >= 0) {
        if (end > 8192) throw new S3Error('InvalidRequest', 'Chunk header too large', 400);
        const value = pending.subarray(0, end).toString('ascii');
        pending = pending.subarray(end + 2);
        return value;
      }
      if (pending.length > 8192) throw new S3Error('InvalidRequest', 'Chunk header too large', 400);
      await pull();
    }
  }
  while (true) {
    const sizeLine = await line();
    if (!/^[0-9a-fA-F]+$/.test(sizeLine))
      throw new S3Error('InvalidRequest', 'Invalid AWS chunk', 400);
    let size = parseInt(sizeLine, 16);
    if (!Number.isSafeInteger(size)) throw new S3Error('InvalidRequest', 'Invalid chunk size', 400);
    if (size === 0) {
      while (true) {
        const trailer = await line();
        if (!trailer) break;
        const colon = trailer.indexOf(':');
        if (colon < 1) throw new S3Error('InvalidRequest', 'Invalid checksum trailer', 400);
        const name = trailer.slice(0, colon).toLowerCase();
        if (name in trailers)
          throw new S3Error('InvalidRequest', 'Duplicate checksum trailer', 400);
        trailers[name] = trailer.slice(colon + 1).trim();
      }
      if (pending.length || !(await iterator.next()).done)
        throw new S3Error('InvalidRequest', 'Data after final chunk', 400);
      return;
    }
    while (size > 0) {
      if (!pending.length) await pull();
      const take = Math.min(size, pending.length);
      yield pending.subarray(0, take);
      pending = pending.subarray(take);
      size -= take;
    }
    if ((await line()) !== '') throw new S3Error('InvalidRequest', 'Invalid chunk separator', 400);
  }
}
export function checkedBody(
  req: IncomingMessage,
  url: URL,
  payloadHash: string,
  metadata: StoredObjectInput,
) {
  const trailers: Record<string, string> = {};
  const chunked = payloadHash === 'STREAMING-UNSIGNED-PAYLOAD-TRAILER';
  if (
    chunked &&
    !field(req, url, 'content-encoding')
      ?.split(',')
      .map((s) => s.trim())
      .includes('aws-chunked')
  )
    throw new S3Error('InvalidRequest', 'Missing aws-chunked encoding', 400);
  if (!chunked && field(req, url, 'content-encoding')?.includes('aws-chunked'))
    throw new S3Error('NotImplemented', 'Signed streaming chunks are unsupported', 501);
  const source: AsyncIterable<Uint8Array> = chunked ? awsChunks(req, trailers) : req;
  const sha256 = createHash('sha256'),
    sha1 = createHash('sha1'),
    md5 = createHash('md5');
  let crc = 0xffffffff,
    crcc = 0xffffffff;
  const declared =
    field(req, url, 'x-amz-trailer')
      ?.split(',')
      .map((s) => s.trim().toLowerCase()) ?? [];
  if (new Set(declared).size !== declared.length)
    throw new S3Error('InvalidRequest', 'Duplicate checksum trailer declaration', 400);
  if (!chunked && declared.length)
    throw new S3Error('InvalidRequest', 'Checksum trailers require aws-chunked encoding', 400);
  for (const name of declared)
    if (!checksumNames.some((algorithm) => name === `x-amz-checksum-${algorithm}`))
      throw new S3Error('NotImplemented', 'Unsupported checksum trailer', 501);
  const crcNeeded =
    declared.includes('x-amz-checksum-crc32') || Boolean(field(req, url, 'x-amz-checksum-crc32'));
  const crccNeeded =
    declared.includes('x-amz-checksum-crc32c') || Boolean(field(req, url, 'x-amz-checksum-crc32c'));
  for (const name of [...Object.keys(req.headers), ...url.searchParams.keys()])
    if (
      name.startsWith('x-amz-checksum-') &&
      !checksumNames.some((alg) => name === `x-amz-checksum-${alg}`)
    )
      throw new S3Error('NotImplemented', 'Unsupported checksum algorithm', 501);
  if (chunked && !declared.length)
    throw new S3Error('InvalidRequest', 'Missing checksum trailer declaration', 400);
  const stream = async function* () {
    for await (const bytes of source) {
      sha256.update(bytes);
      sha1.update(bytes);
      md5.update(bytes);
      if (crcNeeded) for (const byte of bytes) crc = crc32[(crc ^ byte) & 255]! ^ (crc >>> 8);
      if (crccNeeded) for (const byte of bytes) crcc = crc32c[(crcc ^ byte) & 255]! ^ (crcc >>> 8);
      yield bytes;
    }
  };
  const options: ObjectWriteOptions = {
    expectedSize:
      field(req, url, chunked ? 'x-amz-decoded-content-length' : 'content-length') === undefined
        ? undefined
        : integer(
            field(req, url, chunked ? 'x-amz-decoded-content-length' : 'content-length'),
            0,
            10_000_000_000,
          ),
    expectedSha256: /^[a-f0-9]{64}$/.test(payloadHash) ? payloadHash : undefined,
    ifMatch: field(req, url, 'if-match'),
    ifNoneMatch: field(req, url, 'if-none-match'),
    validate: async () => {
      const sha = sha256.digest();
      const checksums = {
        crc32: crcBase64(crc),
        crc32c: crcBase64(crcc),
        sha1: sha1.digest('base64'),
        sha256: sha.toString('base64'),
      };
      if (/^[a-f0-9]{64}$/.test(payloadHash) && sha.toString('hex') !== payloadHash)
        throw new S3Error('XAmzContentSHA256Mismatch', 'Payload hash mismatch', 400);
      const contentMD5 = field(req, url, 'content-md5');
      if (contentMD5 && contentMD5 !== md5.digest('base64'))
        throw new S3Error('BadDigest', 'Content-MD5 mismatch', 400);
      for (const declaredName of declared)
        if (!trailers[declaredName])
          throw new S3Error('BadDigest', 'Missing checksum trailer', 400);
      for (const name of Object.keys(trailers))
        if (!declared.includes(name))
          throw new S3Error('InvalidRequest', 'Undeclared checksum trailer', 400);
      for (const algorithm of checksumNames) {
        const name = `x-amz-checksum-${algorithm}`;
        const headerChecksum = field(req, url, name);
        if (headerChecksum && trailers[name] && headerChecksum !== trailers[name])
          throw new S3Error('BadDigest', 'Conflicting checksum header and trailer', 400);
        const expected = headerChecksum ?? trailers[name];
        if (expected && expected !== checksums[algorithm])
          throw new S3Error('BadDigest', 'Checksum mismatch', 400);
        if (expected) {
          metadata.checksums ??= {};
          metadata.checksums[algorithm] = checksums[algorithm];
        }
      }
    },
  };
  return { stream: stream(), options };
}
export async function readXml(
  req: IncomingMessage,
  url: URL,
  payloadHash: string,
): Promise<Record<string, unknown>> {
  const body = checkedBody(req, url, payloadHash, {});
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const bytes of body.stream) {
    size += bytes.length;
    if (size > 1024 * 1024)
      throw new S3Error('MaxMessageLengthExceeded', 'XML request too large', 400);
    chunks.push(Buffer.from(bytes));
  }
  await body.options.validate!();
  if (body.options.expectedSize !== undefined && body.options.expectedSize !== size)
    throw new S3Error('IncompleteBody', 'Request length does not match the decoded body', 400);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new S3Error('MalformedXML', 'Invalid XML character encoding', 400);
  }
  if (!text) return {};
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
    throw new S3Error('MalformedXML', 'Invalid XML request', 400);
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (name: string) => name === 'Part' || name === 'Object',
  });
  return parser.parse(text) as Record<string, unknown>;
}
export function range(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new S3Error('InvalidRange', 'Invalid range', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    start < 0 ||
    end < start ||
    (!match[1] && Number(match[2]) === 0)
  )
    throw new S3Error('InvalidRange', 'Invalid range', 416);
  return { start, end: Math.min(size - 1, end) };
}
