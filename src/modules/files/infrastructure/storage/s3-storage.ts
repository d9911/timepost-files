import { createHash } from 'node:crypto';
import {
  S3Client,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DirectUploadStoragePort } from '../../application/ports/direct-upload-storage.js';
import type { StoragePort } from '../../application/ports/object-storage.js';
import type { StorageProvider } from '../../domain/file.js';
import type { Environment } from '../../../../shared/infrastructure/environment.js';
import { FileError } from '../../../../shared/application/file-error.js';

export type S3Provider = Extract<StorageProvider, 's3' | 'selectel' | 'aws' | 'yandex-object'>;

// Провайдеры используют один порт; ключи доступа никогда не передаются браузеру.
export class S3Storage implements StoragePort, DirectUploadStoragePort {
  private readonly canPresign: boolean;
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
  constructor(
    environment: Environment,
    readonly provider: S3Provider = 's3',
  ) {
    const bucket = environment.S3_BUCKET;
    const region =
      environment.S3_REGION || (provider === 'yandex-object' ? 'ru-central1' : undefined);
    if (!bucket || !region) throw new Error('Нужны S3_BUCKET и S3_REGION');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
      throw new Error('Неверное имя S3_BUCKET');
    const endpoint =
      environment.S3_ENDPOINT ||
      (provider === 'yandex-object' ? 'https://storage.yandexcloud.net' : undefined);
    const iamToken = environment.YANDEX_IAM_TOKEN;
    if (iamToken && provider !== 'yandex-object')
      throw new Error('YANDEX_IAM_TOKEN поддерживается только для yandex-object');
    if (iamToken && /\s/.test(iamToken)) throw new Error('Неверный YANDEX_IAM_TOKEN');
    if (
      iamToken &&
      (environment.S3_ACCESS_KEY_ID ||
        environment.S3_SECRET_ACCESS_KEY ||
        environment.S3_SESSION_TOKEN)
    )
      throw new Error('Выберите IAM-токен или S3-ключи, не оба режима');
    if (provider !== 'aws' && !endpoint) throw new Error('Нужен S3_ENDPOINT');
    if (endpoint) {
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
        throw new Error('Неверный S3_ENDPOINT');
      if (
        url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          environment.S3_ALLOW_INSECURE_LOCAL === 'true' &&
          ['localhost', '127.0.0.1', '[::1]', 's3mock'].includes(url.hostname)
        )
      )
        throw new Error('S3_ENDPOINT должен использовать HTTPS');
    }
    if (!!environment.S3_ACCESS_KEY_ID !== !!environment.S3_SECRET_ACCESS_KEY)
      throw new Error('Нужны оба S3-ключа');
    if (provider !== 'aws' && !environment.S3_ACCESS_KEY_ID && !iamToken)
      throw new Error('Нужны S3-ключи доступа');
    this.canPresign = !iamToken && !!environment.S3_ACCESS_KEY_ID;
    this.bucket = bucket;
    this.prefix = environment.S3_KEY_PREFIX ?? 'timepost/';
    if (!/^[a-zA-Z0-9/_-]*$/.test(this.prefix) || this.prefix.startsWith('/'))
      throw new Error('Неверный S3_KEY_PREFIX');
    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: environment.S3_FORCE_PATH_STYLE !== 'false',
      maxAttempts: 3,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(iamToken
        ? {
            // SDK requires an identity even with a custom signer; these are not cloud keys.
            credentials: { accessKeyId: 'iam-bearer', secretAccessKey: 'unused' },
            signer: {
              sign: async (request) => ({
                ...request,
                headers: { ...request.headers, authorization: `Bearer ${iamToken}` },
              }),
            },
          }
        : environment.S3_ACCESS_KEY_ID
          ? {
              credentials: {
                accessKeyId: environment.S3_ACCESS_KEY_ID,
                secretAccessKey: environment.S3_SECRET_ACCESS_KEY!,
                ...(environment.S3_SESSION_TOKEN
                  ? { sessionToken: environment.S3_SESSION_TOKEN }
                  : {}),
              },
            }
          : {}),
    });
  }
  key(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new FileError('INVALID_FILE_ID', 'Неверный ID файла');
    return this.prefix + id;
  }
  async ready() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(15000),
    });
    const versioning = await this.client.send(
      new GetBucketVersioningCommand({ Bucket: this.bucket }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    if (versioning.Status)
      throw new FileError('STORAGE_NOT_CONFIGURED', 'Нужен отдельный бакет без истории версий');
  }
  async upload(id: string, bytes: Uint8Array, mimeType = 'application/octet-stream') {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(id),
        Body: bytes,
        ContentType: mimeType,
        ContentMD5: createHash('md5').update(bytes).digest('base64'),
        IfNoneMatch: '*',
      }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
  }
  async download(id: string, objectKey?: string): Promise<AsyncIterable<Uint8Array>> {
    const { Body } = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey ? this.objectKey(objectKey) : this.key(id),
      }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
    if (!Body) throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не вернул содержимое');
    return Body.transformToWebStream();
  }
  async delete(id: string, objectKey?: string) {
    // Повторно проверяем versioning непосредственно перед удалением объекта.
    await this.ready();
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey ? this.objectKey(objectKey) : this.key(id),
      }),
      {
        abortSignal: AbortSignal.timeout(15000),
      },
    );
  }
  private objectKey(key: string): string {
    if (!/^(incoming|media)\/[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)?$/.test(key) || key.includes('//'))
      throw new FileError('INVALID_FILE_ID', 'Неверный ключ объекта');
    return key;
  }
  private presignOptions(expiresIn: number) {
    if (!this.canPresign)
      throw new FileError(
        'STORAGE_NOT_CONFIGURED',
        'Для подписанных ссылок нужны статические S3-ключи',
      );
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600)
      throw new FileError('STORAGE_NOT_CONFIGURED', 'Неверный срок подписанной ссылки');
    return { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) };
  }
  async presignPut(
    key: string,
    mimeType: string,
    sizeBytes: number,
    metadata: Record<string, string>,
    expiresIn: number,
  ) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        ContentType: mimeType,
        ContentLength: sizeBytes,
        Metadata: metadata,
        IfNoneMatch: '*',
      }),
      this.presignOptions(expiresIn),
    );
  }
  async presignGet(key: string, fileName: string, expiresIn: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      }),
      this.presignOptions(expiresIn),
    );
  }
  async createMultipart(key: string, mimeType: string, metadata: Record<string, string>) {
    this.presignOptions(1);
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        ContentType: mimeType,
        Metadata: metadata,
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    if (!result.UploadId)
      throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не вернул ID загрузки');
    return result.UploadId;
  }
  async presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    sizeBytes: number,
    expiresIn: number,
  ) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: sizeBytes,
      }),
      this.presignOptions(expiresIn),
    );
  }
  async listParts(key: string, uploadId: string) {
    const parts: { partNumber: number; sizeBytes: number; etag: string }[] = [];
    let marker: string | undefined;
    do {
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      for (const part of result.Parts ?? []) {
        if (!part.PartNumber || part.Size === undefined || !part.ETag)
          throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 вернул неверную часть');
        parts.push({ partNumber: part.PartNumber, sizeBytes: part.Size, etag: part.ETag });
      }
      const next = result.IsTruncated ? result.NextPartNumberMarker : undefined;
      if (result.IsTruncated && (!next || next === marker))
        throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 вернул неверную пагинацию');
      marker = next;
    } while (marker);
    return parts;
  }
  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
  }
  async abortMultipart(key: string, uploadId: string) {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        UploadId: uploadId,
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  }
  async headObject(key: string) {
    const result = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    if (result.ContentLength === undefined || !result.ETag)
      throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не вернул размер или ETag');
    return {
      sizeBytes: result.ContentLength,
      mimeType: result.ContentType ?? 'application/octet-stream',
      etag: result.ETag,
      metadata: result.Metadata ?? {},
    };
  }
  async downloadObject(
    key: string,
    etag?: string,
    range?: string,
  ): Promise<AsyncIterable<Uint8Array>> {
    const { Body } = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        ...(etag ? { IfMatch: etag } : {}),
        ...(range ? { Range: range } : {}),
      }),
      { abortSignal: AbortSignal.timeout(20 * 60 * 1000) },
    );
    if (!Body) throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не вернул содержимое');
    return Body.transformToWebStream();
  }
  async promoteObject(sourceKey: string, targetKey: string, sizeBytes: number, etag: string) {
    const source = this.objectKey(sourceKey);
    const target = this.objectKey(targetKey);
    if (!source.startsWith('incoming/') || !target.startsWith('media/'))
      throw new FileError('INVALID_FILE_ID', 'Неверное направление копирования');
    const CopySource = `${this.bucket}/${source.split('/').map(encodeURIComponent).join('/')}`;
    if (sizeBytes <= 5_000_000_000) {
      const result = await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: target,
          CopySource,
          CopySourceIfMatch: etag,
        }),
        { abortSignal: AbortSignal.timeout(120000) },
      );
      if (!result.CopyObjectResult?.ETag)
        throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не подтвердил копирование');
      return;
    }
    const original = await this.headObject(source);
    if (original.etag !== etag || original.sizeBytes !== sizeBytes)
      throw new FileError('STORAGE_INVALID_RESPONSE', 'Объект изменился во время проверки');
    const uploadId = await this.createMultipart(target, original.mimeType, original.metadata);
    try {
      const parts: { partNumber: number; etag: string }[] = [];
      const chunkSize = 256 * 1024 * 1024;
      for (let offset = 0; offset < sizeBytes; offset += chunkSize) {
        const partNumber = parts.length + 1;
        const result = await this.client.send(
          new UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: target,
            UploadId: uploadId,
            PartNumber: partNumber,
            CopySource,
            CopySourceIfMatch: etag,
            CopySourceRange: `bytes=${offset}-${Math.min(sizeBytes, offset + chunkSize) - 1}`,
          }),
          { abortSignal: AbortSignal.timeout(120000) },
        );
        if (!result.CopyPartResult?.ETag)
          throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не подтвердил копирование части');
        parts.push({ partNumber, etag: result.CopyPartResult.ETag });
      }
      await this.completeMultipart(target, uploadId, parts);
    } catch (error) {
      await this.abortMultipart(target, uploadId).catch(() => undefined);
      throw error;
    }
  }
  async deleteObject(key: string) {
    await this.ready();
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  }
}
