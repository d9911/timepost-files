import { idPattern, uploadLimit } from '../domain/file-policy.js';
import type { MediaInspector } from './ports/media-inspector.js';
import type { FileIdentity } from './ports/file-identity.js';
import type { AuthorizeProject } from '../../access/contracts.js';
import type { FileRecord } from '../domain/file.js';
import type { FileRepositoryPort } from './ports/file-repository.js';
import type { ServiceOptions } from './contracts.js';
import type { StoragePort } from './ports/object-storage.js';

import { FileError } from '../../../shared/application/file-error.js';

export class FileService {
  constructor(
    private readonly repository: FileRepositoryPort,
    private readonly storage: StoragePort,
    private readonly authorizeProject: AuthorizeProject,
    private readonly mediaInspector: MediaInspector,
    private readonly identity: FileIdentity,
    private readonly options: ServiceOptions = {},
  ) {}

  async upload(
    ownerId: string,
    projectId: string | null,
    bytes: Uint8Array,
    mimeType = 'image/png',
    fileName = 'file',
  ) {
    if (!projectId || !/^\d+$/.test(projectId))
      throw new FileError('INVALID_PROJECT', 'Требуется идентификатор проекта');
    await this.authorizeProject(ownerId, projectId, true);
    if (!bytes.length || bytes.length > uploadLimit(mimeType))
      throw new FileError('FILE_TOO_LARGE', 'Лимит файла: фото 10 МиБ, видео 100 МиБ');
    if (
      typeof fileName !== 'string' ||
      !fileName.trim() ||
      fileName.length > 255 ||
      Array.from(fileName).some(
        (char) => (char.codePointAt(0) ?? 0) < 32 || char.codePointAt(0) === 127,
      )
    )
      throw new FileError('INVALID_FILE_NAME', 'Неверное имя файла');
    const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(
      mimeType,
    );
    if (!mediaType && !this.options.genericFiles)
      throw new FileError('INVALID_IMAGE', 'Разрешены JPEG, PNG, WebP, MP4 и WebM');
    const metadata = mediaType
      ? await this.mediaInspector.inspect(bytes, mimeType)
      : { mimeType: 'application/octet-stream', width: null, height: null };
    const file: FileRecord = {
      id: this.identity.createId(),
      ownerId,
      projectId,
      mimeType: metadata.mimeType,
      sizeBytes: bytes.length,
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      durationSeconds: metadata?.durationSeconds ?? null,
      fileName,
      sha256: this.identity.checksum(bytes),
      provider: this.storage.provider ?? 'yandex',
    };
    await this.repository.insert(file);
    // Незавершённая загрузка остаётся pending и никогда не отдаётся как сохранённый файл.
    await this.storage.upload(file.id, bytes, file.mimeType);
    await this.repository.setStatus(file.id, 'ready');
    return { ...file, status: 'ready' as const };
  }

  async accessible(id: string, userId: string, write = false) {
    if (!idPattern.test(id)) throw new FileError('FILE_NOT_FOUND', 'Файл не найден');
    const file = await this.repository.get(id);
    if (!file || ['pending', 'deleted'].includes(file.status ?? ''))
      throw new FileError('FILE_NOT_FOUND', 'Файл не найден');
    if (file.provider && file.provider !== (this.storage.provider ?? 'yandex'))
      throw new FileError('STORAGE_PROVIDER_MISMATCH', 'Файл относится к другому провайдеру');
    await this.authorizeProject(userId, file.projectId, write);
    if (write && file.ownerId !== userId)
      throw new FileError(
        'FILE_FORBIDDEN',
        'Удалять файл может только загрузивший его пользователь',
      );
    return file;
  }

  async metadata(id: string, userId: string) {
    const file = await this.accessible(id, userId);
    if (file.status !== 'ready') throw new FileError('FILE_DELETING', 'Файл удаляется');
    return file;
  }
  async content(id: string, userId: string) {
    const file = await this.accessible(id, userId);
    if (file.status !== 'ready') throw new FileError('FILE_DELETING', 'Файл удаляется');
    return { file, stream: await this.storage.download(id) };
  }
  async list(userId: string, projectId: string | null, limit = '20', cursor: string | null = null) {
    if (!projectId || !/^\d+$/.test(projectId))
      throw new FileError('INVALID_PROJECT', 'Требуется проект');
    if (
      !/^\d+$/.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 100 ||
      (cursor && !idPattern.test(cursor))
    )
      throw new FileError('INVALID_PAGINATION', 'Неверная пагинация');
    await this.authorizeProject(userId, projectId, false);
    const rows = await this.repository.list(
      projectId,
      Number(limit) + 1,
      cursor,
      this.storage.provider ?? 'yandex',
    );
    return {
      items: rows.slice(0, Number(limit)),
      nextCursor: rows.length > Number(limit) ? rows[Number(limit) - 1]!.id : null,
    };
  }
  async deleteStatus(id: string, userId: string) {
    if (!idPattern.test(id)) throw new FileError('FILE_NOT_FOUND', 'Файл не найден');
    const file = await this.repository.get(id);
    if (!file) throw new FileError('FILE_NOT_FOUND', 'Файл не найден');
    await this.authorizeProject(userId, file.projectId, false);
    if (file.provider !== (this.storage.provider ?? 'yandex'))
      throw new FileError('STORAGE_PROVIDER_MISMATCH', 'Файл другого провайдера');
    const job = await this.repository.deleteStatus(id);
    if (!job) throw new FileError('NOT_FOUND', 'Удаление не запрашивалось');
    return { ...job, maxAttempts: 10 };
  }
  async delete(id: string, userId: string) {
    if (!this.options.deleteEnabled)
      throw new FileError('DELETE_DISABLED', 'Удаление отключено для интеграции с постами');
    await this.accessible(id, userId, true);
    await this.repository.queueDelete(id);
    return { id, status: 'deleting' };
  }
}
