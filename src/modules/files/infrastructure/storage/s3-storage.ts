import { createHash } from 'node:crypto';
import {
  S3Client,
  HeadBucketCommand,
  GetBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { StoragePort } from '../../application/ports/object-storage.js';
import type { StorageProvider } from '../../domain/file.js';
import type { Environment } from '../../../../shared/infrastructure/environment.js';
import { FileError } from '../../../../shared/application/file-error.js';

export type S3Provider = Extract<StorageProvider, 's3' | 'selectel' | 'aws' | 'yandex-object'>;

// Провайдеры используют один порт; ключи доступа никогда не передаются браузеру.
export class S3Storage implements StoragePort {
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
  async download(id: string): Promise<AsyncIterable<Uint8Array>> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id) }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
    if (!Body) throw new FileError('STORAGE_INVALID_RESPONSE', 'S3 не вернул содержимое');
    return Body.transformToWebStream();
  }
  async delete(id: string) {
    // Повторно проверяем versioning непосредственно перед удалением объекта.
    await this.ready();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id) }), {
      abortSignal: AbortSignal.timeout(15000),
    });
  }
}
