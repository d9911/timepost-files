import type { AuthorizeProject } from '../../access/contracts.js';
import type { FileRecord } from '../domain/file.js';
import { idPattern } from '../domain/file-policy.js';
import type { FileIdentity } from './ports/file-identity.js';
import type { MediaInspector } from './ports/media-inspector.js';
import type { DirectUploadStoragePort } from './ports/direct-upload-storage.js';
import type { DirectUploadRepositoryPort } from './ports/direct-upload-repository.js';
import { FileError } from '../../../shared/application/file-error.js';

export const multipartThreshold = 100_000_000;
export const partSize = 16 * 1024 * 1024;
const expiresIn = 900;
const mimeExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};
export interface UploadInput {
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  socialNetwork?: string;
}

export class DirectUploadService {
  private validating = 0;
  constructor(
    private readonly repository: DirectUploadRepositoryPort,
    private readonly storage: DirectUploadStoragePort,
    private readonly authorize: AuthorizeProject,
    private readonly inspector: MediaInspector,
    private readonly identity: FileIdentity,
  ) {}

  async init(ownerId: string, input: UploadInput) {
    if (!/^\d+$/.test(ownerId) || !/^\d+$/.test(input.projectId))
      throw new FileError('INVALID_PROJECT', 'Неверный проект или пользователь');
    await this.authorize(ownerId, input.projectId, true);
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > 10_000_000_000
    )
      throw new FileError('FILE_TOO_LARGE', 'Размер должен быть от 1 байта до 10 GB');
    const extension = mimeExtensions[input.mimeType];
    if (!extension) throw new FileError('INVALID_IMAGE', 'Разрешены JPEG, PNG, WebP, MP4 и WebM');
    if (
      !input.fileName.trim() ||
      input.fileName.length > 255 ||
      Array.from(input.fileName).some(
        (char) => (char.codePointAt(0) ?? 0) < 32 || char.codePointAt(0) === 127,
      )
    )
      throw new FileError('INVALID_FILE_NAME', 'Неверное имя файла');
    if (input.socialNetwork !== undefined && input.socialNetwork !== 'instagram')
      throw new FileError('INVALID_PROJECT', 'Социальная сеть пока не поддерживается');
    const id = this.identity.createId();
    const base = `${ownerId}/${input.projectId}/${id}/original.${extension}`;
    const incomingKey = `incoming/${base}`;
    const file: FileRecord = {
      id,
      ownerId,
      projectId: input.projectId,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      width: null,
      height: null,
      fileName: input.fileName,
      provider: 'yandex-object',
      bucket: this.storage.bucket,
      incomingKey,
      objectKey: `media/${base}`,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      socialNetwork: input.socialNetwork ?? null,
    };
    await this.repository.insert(file); // резерв квоты и числа активных загрузок — под блокировкой пользователя.
    const metadata = { 'upload-id': id, 'owner-id': ownerId, 'project-id': input.projectId };
    try {
      if (input.sizeBytes >= multipartThreshold) {
        const uploadId = await this.storage.createMultipart(incomingKey, input.mimeType, metadata);
        try {
          await this.repository.setMultipart(id, uploadId);
        } catch (error) {
          await this.storage.abortMultipart(incomingKey, uploadId);
          throw error;
        }
        return {
          uploadId: id,
          mode: 'multipart' as const,
          expiresAt: new Date(file.uploadExpiresAt!).toISOString(),
          partSize,
          partCount: Math.ceil(input.sizeBytes / partSize),
        };
      }
      const uploadUrl = await this.storage.presignPut(
        incomingKey,
        input.mimeType,
        input.sizeBytes,
        metadata,
        expiresIn,
      );
      return {
        uploadId: id,
        mode: 'put' as const,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
        uploadUrl,
        headers: { 'Content-Type': input.mimeType, 'If-None-Match': '*' },
      };
    } catch (error) {
      await this.repository.cancelUpload(id, ownerId);
      throw error;
    }
  }
  private async owned(id: string, ownerId: string, write = true) {
    if (!idPattern.test(id)) throw new FileError('FILE_NOT_FOUND', 'Загрузка не найдена');
    const file = await this.repository.get(id);
    if (
      !file ||
      file.ownerId !== ownerId ||
      file.provider !== 'yandex-object' ||
      file.bucket !== this.storage.bucket ||
      !file.incomingKey ||
      !file.objectKey
    )
      throw new FileError('FILE_NOT_FOUND', 'Загрузка не найдена');
    await this.authorize(ownerId, file.projectId, write);
    return file;
  }
  async part(ownerId: string, id: string, partNumber: number) {
    const file = await this.owned(id, ownerId);
    const count = Math.ceil(file.sizeBytes / partSize);
    if (
      file.status !== 'pending' ||
      !file.multipartUploadId ||
      !file.uploadExpiresAt ||
      new Date(file.uploadExpiresAt).getTime() <= Date.now()
    )
      throw new FileError('FILE_NOT_FOUND', 'Загрузка истекла или отменена');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count)
      throw new FileError('INVALID_FILE_ID', 'Неверный номер части');
    const size = Math.min(partSize, file.sizeBytes - (partNumber - 1) * partSize);
    return {
      url: await this.storage.presignPart(
        file.incomingKey!,
        file.multipartUploadId,
        partNumber,
        size,
        expiresIn,
      ),
      headers: {},
    };
  }
  async complete(ownerId: string, id: string, parts?: { partNumber: number; etag: string }[]) {
    await this.owned(id, ownerId);
    if (this.validating >= 2) throw new FileError('UPLOAD_BUSY', 'Повторите завершение позже');
    this.validating++;
    try {
      const result = await this.repository.completeUpload(id, ownerId, async (file) => {
        if (file.bucket !== this.storage.bucket || file.provider !== 'yandex-object')
          throw new FileError('STORAGE_PROVIDER_MISMATCH', 'Загрузка другого провайдера');
        if (file.multipartUploadId) {
          let alreadyUploaded = false;
          try {
            await this.storage.headObject(file.incomingKey!);
            alreadyUploaded = true;
          } catch (error) {
            if (!(error instanceof Error) || !['NotFound', 'NoSuchKey'].includes(error.name))
              throw error;
          }
          if (!alreadyUploaded) {
            const actual = await this.storage.listParts(file.incomingKey!, file.multipartUploadId);
            const expectedCount = Math.ceil(file.sizeBytes / partSize);
            if (
              !parts ||
              parts.length !== expectedCount ||
              actual.length !== expectedCount ||
              actual.some(
                (part, index) =>
                  part.partNumber !== index + 1 ||
                  part.sizeBytes !== Math.min(partSize, file.sizeBytes - index * partSize) ||
                  parts[index]?.partNumber !== part.partNumber ||
                  parts[index]?.etag !== part.etag,
              )
            )
              throw new FileError(
                'STORAGE_INVALID_RESPONSE',
                'Неполные или неверные части загрузки',
              );
            await this.storage.completeMultipart(file.incomingKey!, file.multipartUploadId, parts);
          }
        } else if (parts?.length) throw new FileError('INVALID_FILE_ID', 'Части не нужны для PUT');
        const head = await this.storage.headObject(file.incomingKey!);
        if (
          head.sizeBytes !== file.sizeBytes ||
          head.mimeType !== file.mimeType ||
          head.metadata['upload-id'] !== id ||
          head.metadata['owner-id'] !== ownerId ||
          head.metadata['project-id'] !== file.projectId
        )
          throw new FileError(
            'STORAGE_INVALID_RESPONSE',
            'Размер, формат или metadata объекта не совпадают',
          );
        if (!this.inspector.inspectStream)
          throw new FileError('STORAGE_NOT_CONFIGURED', 'Проверка потока не настроена');
        const media = await this.inspector.inspectStream(
          await this.storage.downloadObject(file.incomingKey!, head.etag),
          file.mimeType,
          file.sizeBytes,
        );
        if (media.mimeType !== file.mimeType)
          throw new FileError('INVALID_IMAGE', 'Содержимое не соответствует заявленному формату');
        await this.storage.promoteObject(
          file.incomingKey!,
          file.objectKey!,
          file.sizeBytes,
          head.etag,
        );
        return media;
      });
      // Готовое состояние уже сохранено: сбой уборки incoming не отменяет успешную загрузку.
      try {
        await this.storage.deleteObject(result.incomingKey!);
      } catch {
        /* lifecycle удалит временный объект */
      }
      return result;
    } finally {
      this.validating--;
    }
  }
  async cancel(ownerId: string, id: string) {
    const file = await this.owned(id, ownerId);
    if (file.status === 'ready' || file.status === 'deleted')
      throw new FileError('FILE_IN_USE', 'Готовую загрузку нельзя отменить');
    const status = await this.repository.cancelUpload(id, ownerId);
    if (status === 'ready' || status === 'deleted')
      throw new FileError('FILE_IN_USE', 'Загрузка уже завершена');
    return { uploadId: id, status: 'deleting' };
  }
  async downloadUrl(file: FileRecord) {
    if (!file.objectKey || file.bucket !== this.storage.bucket || file.provider !== 'yandex-object')
      throw new FileError('STORAGE_PROVIDER_MISMATCH', 'Нет S3-объекта текущего бакета');
    return {
      url: await this.storage.presignGet(file.objectKey, file.fileName ?? 'file', expiresIn),
      expiresIn,
    };
  }
  async content(file: FileRecord, range?: string) {
    if (file.bucket !== this.storage.bucket || !file.objectKey)
      throw new FileError('STORAGE_PROVIDER_MISMATCH', 'Объект другого бакета');
    return this.storage.downloadObject(file.objectKey, undefined, range);
  }
  async thumbnail(file: FileRecord) {
    if (!file.mimeType.startsWith('image/') || !this.inspector.thumbnailStream)
      throw new FileError('INVALID_IMAGE', 'Миниатюра доступна только для фотографий');
    return this.inspector.thumbnailStream(await this.content(file), file.sizeBytes);
  }
}
