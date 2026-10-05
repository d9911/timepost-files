import { randomUUID } from 'node:crypto';
import { validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Error } from '../domain/s3-error.js';
import type { LocalObjectStore, StoredObject } from '../infrastructure/local-object-store.js';
import { authenticateS3, type S3AuthenticationOptions } from '../infrastructure/sigv4.js';
import {
  checkedBody,
  document,
  field,
  integer,
  objectMetadata,
  range,
  readXml,
  tag,
} from './protocol.js';

type Options = S3AuthenticationOptions & { corsOrigins?: string[] };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const unsupported = (): never => {
  throw new S3Error('NotImplemented', 'This S3 operation is not supported', 501);
};
export function createS3Handler(store: LocalObjectStore, options: Options) {
  let activeWrites = 0;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = randomUUID();
    res.setHeader('x-amz-request-id', requestId);
    res.setHeader('x-amz-bucket-region', options.region);
    const reply = (name: string, body: string, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/xml');
      res.end(document(name, body));
    };
    let writing = false;
    try {
      const origin = req.headers.origin;
      if (origin && options.corsOrigins?.includes(origin)) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'Origin');
        res.setHeader(
          'access-control-expose-headers',
          'ETag,Content-Range,x-amz-request-id,x-amz-checksum-crc32,x-amz-checksum-sha256',
        );
        if (req.method === 'OPTIONS') {
          res.setHeader('access-control-allow-methods', 'GET,HEAD,PUT,POST,DELETE');
          res.setHeader(
            'access-control-allow-headers',
            req.headers['access-control-request-headers'] ?? '*',
          );
          res.statusCode = 204;
          res.end();
          return;
        }
      }
      const url = new URL(req.url ?? '/', 'http://s3.local');
      const auth = authenticateS3(req, url, options);
      const rawPath = (req.url ?? '/').split('?')[0]!;
      const separator = rawPath.indexOf('/', 1);
      let bucket: string, key: string;
      try {
        bucket = decodeURIComponent(rawPath.slice(1, separator < 0 ? undefined : separator));
        key = separator < 0 ? '' : decodeURIComponent(rawPath.slice(separator + 1));
      } catch {
        throw new S3Error('InvalidURI', 'Invalid object path encoding', 400);
      }
      const query = url.searchParams;
      const method = req.method;
      for (const name of query.keys())
        if (
          [
            'acl',
            'tagging',
            'policy',
            'cors',
            'lifecycle',
            'website',
            'logging',
            'notification',
            'replication',
            'encryption',
            'object-lock',
            'retention',
            'legal-hold',
            'versionId',
            'versions',
            'restore',
            'torrent',
            'requestPayment',
            'accelerate',
            'inventory',
            'metrics',
            'analytics',
          ].includes(name)
        )
          unsupported();
      for (const name of [...Object.keys(req.headers), ...query.keys()])
        if (
          name === 'x-amz-acl' ||
          name.startsWith('x-amz-grant-') ||
          name.startsWith('x-amz-server-side-encryption') ||
          name.startsWith('x-amz-object-lock-') ||
          name === 'x-amz-tagging'
        )
          unsupported();
      if (method === 'PUT' || method === 'POST') {
        if (activeWrites >= 8) throw new S3Error('SlowDown', 'Too many concurrent uploads', 503);
        activeWrites++;
        writing = true;
      }
      if (!bucket) {
        if (method !== 'GET' || key) unsupported();
        const buckets = await store.listBuckets();
        reply(
          'ListAllMyBucketsResult',
          '<Owner><ID>local</ID><DisplayName>local</DisplayName></Owner><Buckets>' +
            buckets
              .map(
                (b) =>
                  '<Bucket>' + tag('Name', b.name) + tag('CreationDate', b.createdAt) + '</Bucket>',
              )
              .join('') +
            '</Buckets>',
        );
        return;
      }
      if (!key) {
        if (query.has('versioning')) {
          await store.headBucket(bucket);
          if (method !== 'GET') unsupported();
          reply('VersioningConfiguration', '');
          return;
        }
        if (query.has('location')) {
          await store.headBucket(bucket);
          if (method !== 'GET') unsupported();
          reply('LocationConstraint', options.region);
          return;
        }
        if (method === 'PUT') {
          const body = await readXml(req, url, auth.payloadHash);
          const location = record(body.CreateBucketConfiguration).LocationConstraint;
          if (location && location !== options.region)
            throw new S3Error('InvalidLocationConstraint', 'Wrong bucket region', 400);
          await store.createBucket(bucket);
          res.setHeader('location', '/' + bucket);
          res.end();
          return;
        }
        if (method === 'HEAD') {
          await store.headBucket(bucket);
          res.end();
          return;
        }
        if (method === 'DELETE') {
          await store.deleteBucket(bucket);
          res.statusCode = 204;
          res.end();
          return;
        }
        if (method === 'POST' && query.has('delete')) {
          const body = record((await readXml(req, url, auth.payloadHash)).Delete);
          const objects = body.Object as unknown[] | undefined;
          if (!Array.isArray(objects) || !objects.length || objects.length > 1000)
            throw new S3Error('MalformedXML', 'Invalid delete request', 400);
          let result = '';
          for (const entry of objects) {
            const object = record(entry);
            if (object.VersionId) unsupported();
            const objectKey = String(object.Key ?? '');
            await store.deleteObject(bucket, objectKey);
            if (body.Quiet !== 'true') result += '<Deleted>' + tag('Key', objectKey) + '</Deleted>';
          }
          reply('DeleteResult', result);
          return;
        }
        if (method === 'GET' && query.has('uploads')) {
          if (query.has('delimiter')) unsupported();
          const all = await store.listMultipart(bucket, {
            prefix: query.get('prefix') ?? undefined,
            maxUploads: Number.MAX_SAFE_INTEGER,
          });
          const keyMarker = query.get('key-marker'),
            uploadMarker = query.get('upload-id-marker');
          const start = keyMarker
            ? uploadMarker
              ? all.findIndex((u) => u.key === keyMarker && u.uploadId === uploadMarker) + 1
              : all.findIndex((u) => u.key > keyMarker)
            : 0;
          if (uploadMarker && (!keyMarker || start === 0))
            throw new S3Error('InvalidArgument', 'Invalid upload marker', 400);
          const max = integer(query.get('max-uploads'), 1000, 1000);
          const remaining = all.slice(start < 0 ? all.length : start),
            uploads = remaining.slice(0, max),
            truncated = remaining.length > uploads.length;
          reply(
            'ListMultipartUploadsResult',
            tag('Bucket', bucket) +
              tag('MaxUploads', max) +
              tag('IsTruncated', truncated) +
              (truncated && uploads.length
                ? tag('NextKeyMarker', uploads.at(-1)!.key) +
                  tag('NextUploadIdMarker', uploads.at(-1)!.uploadId)
                : '') +
              uploads
                .map(
                  (u) =>
                    '<Upload>' +
                    tag('Key', u.key) +
                    tag('UploadId', u.uploadId) +
                    tag('Initiated', u.initiated) +
                    '<StorageClass>STANDARD</StorageClass></Upload>',
                )
                .join(''),
          );
          return;
        }
        if (method !== 'GET') unsupported();
        const v2 = query.get('list-type') === '2';
        if (query.has('list-type') && !v2)
          throw new S3Error('InvalidArgument', 'Invalid list type', 400);
        const maxKeys = integer(query.get('max-keys'), 1000, 1000);
        const listing = await store.listObjects(bucket, {
          prefix: query.get('prefix') ?? undefined,
          delimiter: query.get('delimiter') ?? undefined,
          maxKeys,
          continuationToken: v2 ? (query.get('continuation-token') ?? undefined) : undefined,
          startAfter: v2
            ? (query.get('start-after') ?? undefined)
            : (query.get('marker') ?? undefined),
        });
        const encode = (value: string) =>
          query.get('encoding-type') === 'url' ? encodeURIComponent(value) : value;
        let result =
          tag('Name', bucket) +
          tag('Prefix', encode(query.get('prefix') ?? '')) +
          tag('MaxKeys', maxKeys) +
          tag('IsTruncated', listing.isTruncated);
        if (query.has('delimiter')) result += tag('Delimiter', encode(query.get('delimiter')!));
        if (query.has('encoding-type')) {
          if (query.get('encoding-type') !== 'url')
            throw new S3Error('InvalidArgument', 'Invalid encoding type', 400);
          result += tag('EncodingType', 'url');
        }
        if (v2) {
          result += tag('KeyCount', listing.objects.length + listing.commonPrefixes.length);
          if (query.has('continuation-token'))
            result += tag('ContinuationToken', query.get('continuation-token'));
          if (query.has('start-after'))
            result += tag('StartAfter', encode(query.get('start-after')!));
          if (listing.nextContinuationToken)
            result += tag('NextContinuationToken', listing.nextContinuationToken);
        } else {
          result += tag('Marker', encode(query.get('marker') ?? ''));
          if (listing.isTruncated)
            result += tag(
              'NextMarker',
              encode(
                [...listing.objects.map((o) => o.key), ...listing.commonPrefixes].sort().at(-1) ??
                  '',
              ),
            );
        }
        result += listing.objects
          .map(
            (o) =>
              '<Contents>' +
              tag('Key', encode(o.key)) +
              tag('LastModified', o.lastModified) +
              tag('ETag', o.etag) +
              tag('Size', o.sizeBytes) +
              '<StorageClass>STANDARD</StorageClass></Contents>',
          )
          .join('');
        result += listing.commonPrefixes
          .map((p) => '<CommonPrefixes>' + tag('Prefix', encode(p)) + '</CommonPrefixes>')
          .join('');
        reply('ListBucketResult', result);
        return;
      }
      const uploadId = query.get('uploadId');
      const checksumHeaders = (object: { checksums?: Record<string, string> }) => {
        for (const [algorithm, value] of Object.entries(object.checksums ?? {}))
          res.setHeader('x-amz-checksum-' + algorithm, value);
      };
      const copySource = async () => {
        const source = field(req, url, 'x-amz-copy-source')!;
        let decoded: string;
        try {
          decoded = decodeURIComponent(source.replace(/^\//, ''));
        } catch {
          throw new S3Error('InvalidArgument', 'Invalid copy source', 400);
        }
        if (decoded.includes('?')) unsupported();
        const slash = decoded.indexOf('/');
        if (slash < 1) throw new S3Error('InvalidArgument', 'Invalid copy source', 400);
        return { bucket: decoded.slice(0, slash), key: decoded.slice(slash + 1) };
      };
      if (uploadId) {
        if (method === 'PUT') {
          const partNumber = integer(query.get('partNumber'), 0, 10000);
          if (partNumber < 1) throw new S3Error('InvalidArgument', 'Invalid part number', 400);
          if (field(req, url, 'x-amz-copy-source')) {
            await readXml(req, url, auth.payloadHash);
            const source = await copySource();
            const object = await store.headObject(source.bucket, source.key);
            const expected = field(req, url, 'x-amz-copy-source-if-match');
            if (expected && expected !== object.etag)
              throw new S3Error('PreconditionFailed', 'Source ETag mismatch', 412);
            const selected = range(field(req, url, 'x-amz-copy-source-range'), object.sizeBytes);
            const read = await store.getObject(source.bucket, source.key, selected);
            const part = await store.uploadPart(bucket, key, uploadId, partNumber, read.stream, {
              expectedSize: selected ? selected.end - selected.start + 1 : object.sizeBytes,
            });
            reply(
              'CopyPartResult',
              tag('LastModified', part.lastModified) + tag('ETag', part.etag),
            );
            return;
          }
          const metadata = objectMetadata(req, url);
          const body = checkedBody(req, url, auth.payloadHash, metadata);
          const part = await store.uploadPart(
            bucket,
            key,
            uploadId,
            partNumber,
            body.stream,
            body.options,
          );
          res.setHeader('etag', part.etag);
          checksumHeaders(metadata);
          res.end();
          return;
        }
        if (method === 'GET') {
          const all = await store.listParts(bucket, key, uploadId);
          const marker = integer(query.get('part-number-marker'), 0, 10000),
            max = integer(query.get('max-parts'), 1000, 1000);
          const available = all.filter((p) => p.partNumber > marker),
            parts = available.slice(0, max);
          reply(
            'ListPartsResult',
            tag('Bucket', bucket) +
              tag('Key', key) +
              tag('UploadId', uploadId) +
              tag('PartNumberMarker', marker) +
              tag('MaxParts', max) +
              tag('IsTruncated', available.length > parts.length) +
              tag('NextPartNumberMarker', parts.at(-1)?.partNumber ?? marker) +
              parts
                .map(
                  (p) =>
                    '<Part>' +
                    tag('PartNumber', p.partNumber) +
                    tag('LastModified', p.lastModified) +
                    tag('ETag', p.etag) +
                    tag('Size', p.sizeBytes) +
                    '</Part>',
                )
                .join(''),
          );
          return;
        }
        if (method === 'DELETE') {
          await store.abortMultipart(bucket, key, uploadId);
          res.statusCode = 204;
          res.end();
          return;
        }
        if (method === 'POST') {
          const body = record((await readXml(req, url, auth.payloadHash)).CompleteMultipartUpload);
          const raw = body.Part;
          if (!Array.isArray(raw)) throw new S3Error('MalformedXML', 'Missing parts', 400);
          const parts = raw.map((p) => {
            const entry = record(p);
            return {
              partNumber: integer(String(entry.PartNumber ?? ''), 0, 10000),
              etag: String(entry.ETag ?? ''),
            };
          });
          const object = await store.completeMultipart(bucket, key, uploadId, parts, {
            ifMatch: field(req, url, 'if-match'),
            ifNoneMatch: field(req, url, 'if-none-match'),
          });
          reply(
            'CompleteMultipartUploadResult',
            tag('Location', '/' + bucket + '/' + key) +
              tag('Bucket', bucket) +
              tag('Key', key) +
              tag('ETag', object.etag),
          );
          return;
        }
        unsupported();
      }
      if (method === 'POST' && query.has('uploads')) {
        await readXml(req, url, auth.payloadHash);
        const id = await store.initiateMultipart(bucket, key, objectMetadata(req, url));
        reply(
          'InitiateMultipartUploadResult',
          tag('Bucket', bucket) + tag('Key', key) + tag('UploadId', id),
        );
        return;
      }
      if (method === 'PUT') {
        if (field(req, url, 'x-amz-copy-source')) {
          await readXml(req, url, auth.payloadHash);
          const source = await copySource();
          const directive = field(req, url, 'x-amz-metadata-directive') ?? 'COPY';
          if (!['COPY', 'REPLACE'].includes(directive))
            throw new S3Error('InvalidArgument', 'Invalid metadata directive', 400);
          const object = await store.copyObject(
            source.bucket,
            source.key,
            bucket,
            key,
            directive === 'REPLACE' ? objectMetadata(req, url) : undefined,
            field(req, url, 'x-amz-copy-source-if-match'),
          );
          reply(
            'CopyObjectResult',
            tag('LastModified', object.lastModified) + tag('ETag', object.etag),
          );
          return;
        }
        const metadata = objectMetadata(req, url);
        const body = checkedBody(req, url, auth.payloadHash, metadata);
        const object = await store.putObject(bucket, key, body.stream, metadata, body.options);
        res.setHeader('etag', object.etag);
        checksumHeaders(object);
        res.end();
        return;
      }
      if (method === 'DELETE') {
        await store.deleteObject(bucket, key);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        for (const name of [
          'content-type',
          'content-encoding',
          'cache-control',
          'content-disposition',
          'content-language',
          'expires',
        ]) {
          try {
            validateHeaderValue(name, query.get('response-' + name) ?? '');
          } catch {
            throw new S3Error('InvalidArgument', 'Invalid response header', 400);
          }
        }
        const read =
          method === 'GET'
            ? await store.getObject(bucket, key, (size) => range(field(req, url, 'range'), size))
            : undefined;
        const object: StoredObject = read?.object ?? (await store.headObject(bucket, key));
        const discard = () => {
          if (read?.stream && 'destroy' in read.stream) (read.stream as Readable).destroy();
        };
        const match = field(req, url, 'if-match');
        if (match && match !== '*' && match !== object.etag) {
          discard();
          throw new S3Error('PreconditionFailed', 'ETag mismatch', 412);
        }
        const none = field(req, url, 'if-none-match');
        if (none && (none === '*' || none === object.etag)) {
          discard();
          res.statusCode = 304;
          res.end();
          return;
        }
        const selected = range(field(req, url, 'range'), object.sizeBytes);
        res.setHeader('etag', object.etag);
        res.setHeader('last-modified', new Date(object.lastModified).toUTCString());
        res.setHeader('accept-ranges', 'bytes');
        for (const [name, value] of Object.entries(object.metadata))
          res.setHeader('x-amz-meta-' + name, value);
        const headers: Record<string, string | undefined> = {
          'content-type': object.contentType,
          'content-encoding': object.contentEncoding,
          'cache-control': object.cacheControl,
          'content-disposition': object.contentDisposition,
        };
        for (const name of [
          'content-type',
          'content-encoding',
          'cache-control',
          'content-disposition',
          'content-language',
          'expires',
        ]) {
          const value = query.get('response-' + name) ?? headers[name];
          if (value !== undefined) {
            if (/[\r\n]/.test(value))
              throw new S3Error('InvalidArgument', 'Invalid response header', 400);
            res.setHeader(name, value);
          }
        }
        if (!selected && field(req, url, 'x-amz-checksum-mode') === 'ENABLED')
          checksumHeaders(object);
        res.setHeader(
          'content-length',
          selected ? selected.end - selected.start + 1 : object.sizeBytes,
        );
        if (selected) {
          res.statusCode = 206;
          res.setHeader(
            'content-range',
            `bytes ${selected.start}-${selected.end}/${object.sizeBytes}`,
          );
        }
        if (method === 'HEAD') {
          res.end();
          return;
        }
        await pipeline(Readable.from(read!.stream), res);
        return;
      }
      unsupported();
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const failure =
        error instanceof S3Error
          ? error
          : new S3Error('InternalError', 'Internal storage error', 500);
      res.statusCode = failure.status;
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      reply(
        'Error',
        tag('Code', failure.code) +
          tag('Message', failure.message) +
          tag('Resource', req.url ?? '/') +
          tag('RequestId', requestId),
        failure.status,
      );
    } finally {
      if (writing) activeWrites--;
    }
  };
}
