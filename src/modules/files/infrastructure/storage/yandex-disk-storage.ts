import type { HttpRequest } from '../../../../shared/infrastructure/http-request.js';
import type { StoragePort } from '../../application/ports/object-storage.js';
import { isRecord } from '../../../../shared/guards/is-record.js';
import { FileError } from '../../../../shared/application/file-error.js';

const apiOrigin = 'https://cloud-api.yandex.net/v1/disk';

export function validateTransferUrl(href: unknown) {
  let url;
  try {
    if (typeof href !== 'string') throw new Error('url');
    url = new URL(href);
  } catch {
    throw new FileError('STORAGE_INVALID_RESPONSE', 'Хранилище вернуло неверный адрес');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['disk.yandex.net', 'storage.yandex.net', 'disk.yandex.ru', 'downloader.yandex.ru'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new FileError('STORAGE_INVALID_RESPONSE', 'Адрес загрузки хранилища не разрешён');
  }
  return url;
}

export class YandexDiskStorage implements StoragePort {
  readonly provider = 'yandex' as const;
  async ready() {
    await this.api('/resources', { path: 'app:/timepost' }, 'PUT');
  }
  constructor(
    public readonly token: string | undefined,
    public readonly request: HttpRequest = fetch,
  ) {}

  async api(
    path: string,
    parameters: Record<string, string | boolean>,
    method = 'GET',
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.token)
      throw new FileError('STORAGE_NOT_CONFIGURED', 'Не настроен OAuth-токен Яндекс Диска');
    const url = new URL(`${apiOrigin}${path}`);
    for (const [name, value] of Object.entries(parameters))
      url.searchParams.set(name, String(value));
    const response = await this.request(url, {
      method,
      headers: { Authorization: `OAuth ${this.token}` },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) {
      if (method === 'PUT' && path === '/resources' && response.status === 409) return;
      if (method === 'DELETE' && response.status === 404) return;
      throw new FileError('STORAGE_UNAVAILABLE', 'Яндекс Диск отклонил операцию');
    }
    if (response.status === 202)
      throw new FileError('STORAGE_OPERATION_PENDING', 'Операция хранилища ещё не завершена');
    return response.status === 204 || method === 'PUT' || method === 'DELETE'
      ? undefined
      : this.linkResponse(response);
  }

  async linkResponse(response: Response): Promise<Record<string, unknown>> {
    const value: unknown = await response.json();
    if (!isRecord(value))
      throw new FileError('STORAGE_INVALID_RESPONSE', 'Неверный ответ хранилища');
    return value;
  }

  path(id: string) {
    return `app:/timepost/${id}`;
  }

  async upload(id: string, bytes: Uint8Array, mimeType = 'application/octet-stream') {
    await this.api('/resources', { path: 'app:/timepost' }, 'PUT');
    const link = await this.api('/resources/upload', {
      path: this.path(id),
      overwrite: false,
    });
    if (link?.method !== 'PUT')
      throw new FileError('STORAGE_INVALID_RESPONSE', 'Неверный способ загрузки');
    // OAuth-токен передаётся только API Яндекса, а не временному адресу загрузки.
    const response = await this.request(validateTransferUrl(link.href), {
      method: 'PUT',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': mimeType },
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (response.status === 202)
      throw new FileError('STORAGE_OPERATION_PENDING', 'Хранилище ещё не подтвердило загрузку');
    if (!response.ok) throw new FileError('STORAGE_UNAVAILABLE', 'Не удалось сохранить файл');
  }

  async download(id: string) {
    const link = await this.api('/resources/download', { path: this.path(id) });
    const response = await this.request(validateTransferUrl(link?.href), {
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!response.ok) throw new FileError('STORAGE_UNAVAILABLE', 'Не удалось прочитать файл');
    if (!response.body)
      throw new FileError('STORAGE_INVALID_RESPONSE', 'Хранилище вернуло пустой поток');
    return response.body;
  }

  async delete(id: string) {
    await this.api('/resources', { path: this.path(id), permanently: true }, 'DELETE');
  }
}
