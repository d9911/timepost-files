import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { S3Error } from '../domain/s3-error.js';

export interface S3AuthenticationOptions {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now?: () => Date;
}

export interface S3Authentication {
  payloadHash: string;
  principal: string;
}

const algorithm = 'AWS4-HMAC-SHA256';
const maximumSkew = 15 * 60 * 1000;
const hexadecimalHash = /^[a-f0-9]{64}$/;

function invalid(message: string): never {
  throw new S3Error('InvalidRequest', message, 400);
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) count += 1;
  }
  if (count > 1) invalid(`Duplicate ${name} header`);
  const value = request.headers[name];
  if (Array.isArray(value)) invalid(`Duplicate ${name} header`);
  return value;
}

function queryParameter(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) invalid(`Expected one ${name} parameter`);
  return values[0];
}

function timestamp(value: string): number {
  if (!/^\d{8}T\d{6}Z$/.test(value)) invalid('Invalid signing timestamp');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  const date = new Date(iso);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().replace(/[-:]/g, '').replace('.000', '') !== value
  ) {
    invalid('Invalid signing timestamp');
  }
  return date.getTime();
}

function canonicalPath(request: IncomingMessage, url: URL): string {
  // WHATWG URL normalizes dot segments. Sign the original S3 request target instead.
  const path = request.url?.split('?')[0] ?? url.pathname;
  if (!path.startsWith('/')) invalid('Expected an origin-form request target');
  try {
    return path
      .split('/')
      .map((segment) => encode(decodeURIComponent(segment)))
      .join('/');
  } catch {
    return invalid('Invalid path encoding');
  }
}

function canonicalQuery(url: URL, presigned: boolean): string {
  const pairs = Array.from(url.searchParams.entries())
    .filter(([name]) => !presigned || name !== 'X-Amz-Signature')
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName < rightName
        ? -1
        : leftName > rightName
          ? 1
          : leftValue < rightValue
            ? -1
            : leftValue > rightValue
              ? 1
              : 0,
    );
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
}

function canonicalHeaders(request: IncomingMessage, signedHeaders: string): string {
  const names = signedHeaders.split(';');
  if (
    !names.includes('host') ||
    names.some((name) => !/^[a-z0-9-]+$/.test(name)) ||
    new Set(names).size !== names.length ||
    [...names].sort().join(';') !== signedHeaders
  ) {
    invalid('SignedHeaders must contain host and unique, sorted lowercase header names');
  }
  return names
    .map((name) => {
      const value = singleHeader(request, name);
      if (value === undefined) invalid(`Missing signed header ${name}`);
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
}

/** Verify static-key S3 SigV4. The caller must verify a signed payload hash against the body. */
export function authenticateS3(
  request: IncomingMessage,
  url: URL,
  options: S3AuthenticationOptions,
): S3Authentication {
  const authorization = singleHeader(request, 'authorization');
  const presigned = url.searchParams.has('X-Amz-Algorithm');
  if (!authorization && !presigned)
    throw new S3Error('AccessDenied', 'S3 authentication is required', 403);
  if (authorization && presigned) invalid('Multiple authentication mechanisms');
  if (
    singleHeader(request, 'x-amz-security-token') ||
    url.searchParams.has('X-Amz-Security-Token')
  ) {
    throw new S3Error('NotImplemented', 'Temporary session credentials are not supported', 501);
  }
  for (const name of url.searchParams.keys()) {
    if (name.startsWith('X-Amz-') && url.searchParams.getAll(name).length !== 1)
      invalid(`Duplicate ${name} parameter`);
  }

  let credential: string;
  let signedHeaders: string;
  let signature: string;
  let date: string;
  if (presigned) {
    if (queryParameter(url, 'X-Amz-Algorithm') !== algorithm)
      invalid('Unsupported signing algorithm');
    credential = queryParameter(url, 'X-Amz-Credential');
    signedHeaders = queryParameter(url, 'X-Amz-SignedHeaders');
    signature = queryParameter(url, 'X-Amz-Signature');
    date = queryParameter(url, 'X-Amz-Date');
  } else {
    const match =
      /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([a-f0-9]{64})$/.exec(
        authorization ?? '',
      );
    if (!match) invalid('Malformed Authorization header');
    credential = match[1]!;
    signedHeaders = match[2]!;
    signature = match[3]!;
    date = singleHeader(request, 'x-amz-date') ?? invalid('Missing x-amz-date');
    if (!signedHeaders.split(';').includes('x-amz-date'))
      invalid('Signing timestamp must be signed');
  }
  if (!hexadecimalHash.test(signature)) invalid('Invalid signature encoding');
  const [accessKeyId, scopeDate, region, service, terminal, ...extra] = credential.split('/');
  if (accessKeyId !== options.accessKeyId)
    throw new S3Error('InvalidAccessKeyId', 'Unknown access key', 403);
  if (
    extra.length ||
    scopeDate !== date.slice(0, 8) ||
    region !== options.region ||
    service !== 's3' ||
    terminal !== 'aws4_request'
  ) {
    throw new S3Error('AuthorizationHeaderMalformed', 'Invalid credential scope', 400);
  }
  const signedAt = timestamp(date);
  const now = (options.now?.() ?? new Date()).getTime();
  if (presigned) {
    const expires = queryParameter(url, 'X-Amz-Expires');
    if (!/^[0-9]+$/.test(expires) || Number(expires) < 1 || Number(expires) > 604800)
      invalid('X-Amz-Expires must be between 1 and 604800 seconds');
    if (signedAt - now > maximumSkew)
      throw new S3Error('RequestTimeTooSkewed', 'Signing timestamp is in the future', 403);
    if (now > signedAt + Number(expires) * 1000)
      throw new S3Error('AccessDenied', 'Request has expired', 403);
  } else if (Math.abs(now - signedAt) > maximumSkew) {
    throw new S3Error(
      'RequestTimeTooSkewed',
      'Signing timestamp is outside the permitted window',
      403,
    );
  }
  const headerHash = singleHeader(request, 'x-amz-content-sha256');
  const queryHash =
    url.searchParams.get('X-Amz-Content-Sha256') ?? url.searchParams.get('x-amz-content-sha256');
  if (headerHash && queryHash && headerHash !== queryHash) invalid('Conflicting payload hashes');
  const payloadHash =
    headerHash ??
    queryHash ??
    (presigned ? 'UNSIGNED-PAYLOAD' : invalid('Missing x-amz-content-sha256'));
  if (
    !hexadecimalHash.test(payloadHash) &&
    payloadHash !== 'UNSIGNED-PAYLOAD' &&
    payloadHash !== 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'
  ) {
    throw new S3Error('NotImplemented', 'This payload signing mechanism is not supported', 501);
  }
  const headers = canonicalHeaders(request, signedHeaders);
  const signedNames = new Set(signedHeaders.split(';'));
  for (const [name, value] of Object.entries(request.headers)) {
    if (!name.startsWith('x-amz-') || name === 'x-amz-content-sha256' || signedNames.has(name))
      continue;
    // Presigning may hoist x-amz headers into the signed query string. A header
    // supplied alongside that parameter must agree with the authenticated value.
    const queryValue = url.searchParams.get(name);
    if (!presigned || queryValue === null || typeof value !== 'string' || queryValue !== value) {
      invalid(`Unsigned S3 header ${name}`);
    }
  }
  const canonical = [
    request.method ?? 'GET',
    canonicalPath(request, url),
    canonicalQuery(url, presigned),
    headers,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${scopeDate}/${region}/s3/aws4_request`;
  const stringToSign = [algorithm, date, scope, hash(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, scopeDate!), region!), 's3'),
    'aws4_request',
  );
  const expected = hmac(key, stringToSign);
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
    throw new S3Error('SignatureDoesNotMatch', 'The request signature does not match', 403);
  }
  return { payloadHash, principal: accessKeyId };
}
