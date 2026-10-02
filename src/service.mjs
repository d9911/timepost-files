import { createHash, randomUUID } from 'node:crypto';

import sharp from 'sharp';

import { FileError } from './errors.mjs';

export const maxBytes = 10 * 1024 * 1024;
const formats = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function publicMetadata(file, prefix = '/api/files-service') {
  return {
    id: file.id,
    mediaFileId: file.id,
    projectId: file.projectId,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
    url: `${prefix}/api/v1/files/${file.id}/content`,
    ...(file.fileName ? { fileName: file.fileName } : {}),
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
    ...(file.provider ? { storageProvider: file.provider } : {}),
    ...(file.createdAt ? { createdAt: new Date(file.createdAt).toISOString() } : {}),
  };
}

export class FileService {
  constructor(repository, storage, authorizeProject, options = {}) {
    this.options = options;
    this.repository = repository;
    this.storage = storage;
    this.authorizeProject = authorizeProject;
  }

  async upload(ownerId, projectId, bytes, mimeType = 'image/png', fileName = 'file') {
    if (!/^\d+$/.test(projectId ?? ''))
      throw new FileError(400, 'INVALID_PROJECT', 'Требуется идентификатор проекта');
    await this.authorizeProject(ownerId, projectId, true);
    if (!bytes.length || bytes.length > maxBytes)
      throw new FileError(413, 'FILE_TOO_LARGE', 'Максимальный размер фотографии — 10 МиБ');
    if (
      typeof fileName !== 'string' ||
      !fileName.trim() ||
      fileName.length > 255 ||
      Array.from(fileName).some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    )
      throw new FileError(400, 'INVALID_FILE_NAME', 'Неверное имя файла');
    let metadata;
    const imageType = ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType);
    if (!imageType && !this.options.genericFiles)
      throw new FileError(415, 'INVALID_IMAGE', 'Разрешены только фотографии');
    if (imageType) {
      try {
        const image = sharp(bytes, {
          limitInputPixels: 4096 * 4096,
          failOn: 'warning',
        });
        metadata = await image.metadata();
        if (
          !formats[metadata.format] ||
          !metadata.width ||
          !metadata.height ||
          metadata.width > 4096 ||
          metadata.height > 4096 ||
          (metadata.pages ?? 1) !== 1
        )
          throw new Error('format');
        // Полное декодирование отсекает повреждённые файлы, прошедшие чтение заголовка.
        await image.stats();
      } catch {
        throw new FileError(
          415,
          'INVALID_IMAGE',
          'Нужна фотография JPEG, PNG или WebP до 4096×4096',
        );
      }
    }
    const file = {
      id: randomUUID(),
      ownerId,
      projectId,
      mimeType: imageType ? formats[metadata.format] : 'application/octet-stream',
      sizeBytes: bytes.length,
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      fileName,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      provider: this.storage.provider ?? 'yandex',
    };
    await this.repository.insert(file);
    // Незавершённая загрузка остаётся pending и никогда не отдаётся как сохранённый файл.
    await this.storage.upload(file.id, bytes, file.mimeType);
    await this.repository.setStatus(file.id, 'ready');
    return publicMetadata(file, this.options.contentPrefix);
  }

  async accessible(id, userId, write = false) {
    if (!idPattern.test(id)) throw new FileError(404, 'FILE_NOT_FOUND', 'Файл не найден');
    const file = await this.repository.get(id);
    if (!file || ['pending', 'deleted'].includes(file.status))
      throw new FileError(404, 'FILE_NOT_FOUND', 'Файл не найден');
    if (file.provider && file.provider !== (this.storage.provider ?? 'yandex'))
      throw new FileError(503, 'STORAGE_PROVIDER_MISMATCH', 'Файл относится к другому провайдеру');
    await this.authorizeProject(userId, file.projectId, write);
    if (write && file.ownerId !== userId)
      throw new FileError(
        403,
        'FILE_FORBIDDEN',
        'Удалять файл может только загрузивший его пользователь',
      );
    return file;
  }

  async metadata(id, userId) {
    const file = await this.accessible(id, userId);
    if (file.status !== 'ready') throw new FileError(409, 'FILE_DELETING', 'Файл удаляется');
    return publicMetadata(file, this.options.contentPrefix);
  }
  async content(id, userId) {
    const file = await this.accessible(id, userId);
    if (file.status !== 'ready') throw new FileError(409, 'FILE_DELETING', 'Файл удаляется');
    return { file, response: await this.storage.download(id) };
  }
  async list(userId, projectId, limit = '20', cursor = null) {
    if (!/^\d+$/.test(projectId ?? ''))
      throw new FileError(400, 'INVALID_PROJECT', 'Требуется проект');
    if (
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100 ||
      (cursor && !idPattern.test(cursor))
    )
      throw new FileError(400, 'INVALID_PAGINATION', 'Неверная пагинация');
    await this.authorizeProject(userId, projectId, false);
    const rows = await this.repository.list(
      projectId,
      Number(limit) + 1,
      cursor,
      this.storage.provider ?? 'yandex',
    );
    return {
      items: rows
        .slice(0, Number(limit))
        .map((file) => publicMetadata(file, this.options.contentPrefix)),
      nextCursor: rows.length > Number(limit) ? rows[Number(limit) - 1].id : null,
    };
  }
  async deleteStatus(id, userId) {
    if (!idPattern.test(id)) throw new FileError(404, 'FILE_NOT_FOUND', 'Файл не найден');
    const file = await this.repository.get(id);
    if (!file) throw new FileError(404, 'FILE_NOT_FOUND', 'Файл не найден');
    await this.authorizeProject(userId, file.projectId, false);
    if (file.provider !== (this.storage.provider ?? 'yandex'))
      throw new FileError(503, 'STORAGE_PROVIDER_MISMATCH', 'Файл другого провайдера');
    const job = await this.repository.deleteStatus(id);
    if (!job) throw new FileError(404, 'NOT_FOUND', 'Удаление не запрашивалось');
    return { ...job, maxAttempts: 10 };
  }
  async delete(id, userId) {
    if (!this.options.deleteEnabled)
      throw new FileError(403, 'DELETE_DISABLED', 'Удаление отключено для интеграции с постами');
    await this.accessible(id, userId, true);
    await this.repository.queueDelete(id);
    return { id, status: 'deleting' };
  }
}
