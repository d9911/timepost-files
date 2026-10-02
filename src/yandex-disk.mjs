import { FileError } from './errors.mjs';

const apiOrigin = 'https://cloud-api.yandex.net/v1/disk';

export function validateTransferUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    throw new FileError(502, 'STORAGE_INVALID_RESPONSE', 'Хранилище вернуло неверный адрес');
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
    throw new FileError(502, 'STORAGE_INVALID_RESPONSE', 'Адрес загрузки хранилища не разрешён');
  }
  return url;
}

export class YandexDiskStorage {
  provider = 'yandex';
  async ready() {
    await this.api('/resources', { path: 'app:/timepost' }, 'PUT');
  }
  constructor(token, request = fetch) {
    this.token = token;
    this.request = request;
  }

  async api(path, parameters, method = 'GET') {
    if (!this.token)
      throw new FileError(503, 'STORAGE_NOT_CONFIGURED', 'Не настроен OAuth-токен Яндекс Диска');
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
      throw new FileError(502, 'STORAGE_UNAVAILABLE', 'Яндекс Диск отклонил операцию');
    }
    if (response.status === 202)
      throw new FileError(503, 'STORAGE_OPERATION_PENDING', 'Операция хранилища ещё не завершена');
    return response.status === 204 || method === 'PUT' || method === 'DELETE'
      ? undefined
      : response.json();
  }

  path(id) {
    return `app:/timepost/${id}`;
  }

  async upload(id, bytes, mimeType) {
    await this.api('/resources', { path: 'app:/timepost' }, 'PUT');
    const link = await this.api('/resources/upload', {
      path: this.path(id),
      overwrite: false,
    });
    if (link?.method !== 'PUT')
      throw new FileError(502, 'STORAGE_INVALID_RESPONSE', 'Неверный способ загрузки');
    // OAuth-токен передаётся только API Яндекса, а не временному адресу загрузки.
    const response = await this.request(validateTransferUrl(link.href), {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': mimeType },
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (response.status === 202)
      throw new FileError(
        503,
        'STORAGE_OPERATION_PENDING',
        'Хранилище ещё не подтвердило загрузку',
      );
    if (!response.ok) throw new FileError(502, 'STORAGE_UNAVAILABLE', 'Не удалось сохранить файл');
  }

  async download(id) {
    const link = await this.api('/resources/download', { path: this.path(id) });
    const response = await this.request(validateTransferUrl(link?.href), {
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    if (!response.ok) throw new FileError(502, 'STORAGE_UNAVAILABLE', 'Не удалось прочитать файл');
    return response;
  }

  async delete(id) {
    await this.api('/resources', { path: this.path(id), permanently: true }, 'DELETE');
  }
}
