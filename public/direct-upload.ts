/** The application authorizes uploads; object bytes travel directly to Yandex S3. */
export type UploadRequest = (path: string, options?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function data(
  request: UploadRequest,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await request(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const envelope: unknown = await response.json();
  if (!record(envelope) || envelope.success !== true || !record(envelope.data))
    throw new Error('Файловый сервис вернул неверный ответ');
  return envelope.data;
}
export function trustedStorageUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Неверный адрес хранилища');
  const url = new URL(value);
  const yandex =
    url.hostname === 'storage.yandexcloud.net' ||
    /^[a-z0-9][a-z0-9.-]*\.storage\.yandexcloud\.net$/.test(url.hostname);
  const local =
    typeof location !== 'undefined' &&
    ['localhost', '127.0.0.1'].includes(location.hostname) &&
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.protocol === location.protocol;
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!(yandex && url.protocol === 'https:' && (!url.port || url.port === '443')) && !local)
  )
    throw new Error('Небезопасный адрес хранилища');
  return url.href;
}
async function put(
  url: unknown,
  headers: unknown,
  body: Blob,
  signal?: AbortSignal,
): Promise<Response> {
  if (
    !record(headers) ||
    !Object.entries(headers).every(
      ([key, value]) =>
        typeof value === 'string' && !/^(authorization|cookie|proxy-authorization)$/i.test(key),
    )
  )
    throw new Error('Неверные заголовки хранилища');
  const response = await fetch(trustedStorageUrl(url), {
    method: 'PUT',
    headers: headers as Record<string, string>,
    body,
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`Ошибка загрузки в хранилище (${response.status})`);
  return response;
}
export async function uploadFile(
  request: UploadRequest,
  file: File,
  projectId: string,
  fileName = file.name,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const capabilities = await data(request, '/api/v1/storage');
  if (typeof capabilities.directUploads !== 'boolean')
    throw new Error('Неверные возможности хранилища');
  const media = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(
    file.type,
  );
  const direct = capabilities.directUploads && media;
  if (capabilities.directUploads && !media && capabilities.genericFiles !== true)
    throw new Error('Неподдерживаемый тип медиа');
  const maximum = direct
    ? capabilities.maxFileBytes
    : file.type.startsWith('video/')
      ? capabilities.maxVideoBytes
      : capabilities.maxBytes;
  if (typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum <= 0)
    throw new Error('Неверный лимит хранилища');
  if (file.size > maximum || file.size === 0)
    throw new Error('Размер файла превышает лимит или файл пуст');
  if (!direct) {
    const query = new URLSearchParams({ projectId, fileName });
    const response = await request(`/api/v1/files?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const envelope: unknown = await response.json();
    if (!record(envelope) || envelope.success !== true || !record(envelope.data))
      throw new Error('Файловый сервис вернул неверный ответ');
    return envelope.data;
  }
  if (capabilities.multipartThreshold !== 100000000 || capabilities.partSize !== 16777216)
    throw new Error('Неверные настройки загрузки хранилища');
  let uploadId: string | undefined;
  try {
    const session = await data(request, '/api/v1/media/upload/init', {
      projectId,
      fileName,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      socialNetwork: 'instagram',
    });
    if (typeof session.uploadId !== 'string' || !session.uploadId)
      throw new Error('Неверная сессия загрузки');
    uploadId = session.uploadId;
    if (
      typeof session.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      throw new Error('Сессия загрузки истекла');
    const parts: { partNumber: number; etag: string }[] = [];
    if (session.mode === 'put' && file.size < capabilities.multipartThreshold) {
      await put(session.uploadUrl, session.headers, file, signal);
    } else if (
      session.mode === 'multipart' &&
      file.size >= capabilities.multipartThreshold &&
      session.partSize === capabilities.partSize &&
      session.partCount === Math.ceil(file.size / capabilities.partSize)
    ) {
      for (let partNumber = 1; partNumber <= session.partCount; partNumber++) {
        const part = await data(request, '/api/v1/media/upload/part', { uploadId, partNumber });
        const response = await put(
          part.url,
          part.headers,
          file.slice((partNumber - 1) * session.partSize, partNumber * session.partSize),
          signal,
        );
        const etag = response.headers.get('ETag');
        if (!etag) throw new Error('Хранилище не вернуло ETag: проверьте CORS');
        parts.push({ partNumber, etag });
      }
    } else throw new Error('Неверный режим загрузки');
    return await data(request, '/api/v1/media/upload/complete', {
      uploadId,
      ...(parts.length ? { parts } : {}),
    });
  } catch (error) {
    if (uploadId)
      await data(request, '/api/v1/media/upload/cancel', { uploadId }).catch(() => undefined);
    throw error;
  }
}
