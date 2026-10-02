import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { FileError } from './errors.mjs';
import { maxBytes, maxVideoBytes, uploadLimit } from './service.mjs';

async function readBytes(source, limit = maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > limit)
      throw new FileError(413, 'FILE_TOO_LARGE', 'Превышен допустимый размер файла');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createHandler(service, authenticate, ready) {
  let uploads = 0;
  return async (request, response) => {
    const json = (status, value) => {
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://files');
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        await ready();
        return json(200, { status: 'ok' });
      }
      if (
        request.method === 'GET' &&
        service.options?.uiEnabled &&
        ['/', '/app.js', '/style.css'].includes(url.pathname)
      ) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = {
          'index.html': 'text/html; charset=utf-8',
          'app.js': 'text/javascript; charset=utf-8',
          'style.css': 'text/css; charset=utf-8',
        }[name];
        response.writeHead(200, {
          'Content-Type': type,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        });
        return response.end(await readFile(new URL(`../public/${name}`, import.meta.url)));
      }
      const userId = await authenticate(request.headers.authorization);
      if (request.method === 'GET' && url.pathname === '/api/v1/storage')
        return json(200, {
          success: true,
          data: {
            provider: service.storage.provider ?? 'yandex',
            authMode: service.options?.authMode ?? 'timepost',
            maxBytes,
            maxVideoBytes,
            genericFiles: service.options?.genericFiles === true,
            deleteEnabled: service.options?.deleteEnabled === true,
          },
        });
      if (request.method === 'GET' && url.pathname === '/api/v1/files')
        return json(200, {
          success: true,
          data: await service.list(
            userId,
            url.searchParams.get('projectId'),
            url.searchParams.get('limit') ?? '20',
            url.searchParams.get('cursor'),
          ),
        });
      if (request.method === 'POST' && url.pathname === '/api/v1/files') {
        if (uploads >= 4) throw new FileError(429, 'UPLOAD_BUSY', 'Повторите загрузку позже');
        if (
          !service.options?.genericFiles &&
          !['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(
            request.headers['content-type']?.split(';')[0],
          )
        )
          throw new FileError(415, 'INVALID_IMAGE', 'Неподдерживаемый тип фотографии');
        if (
          Number(request.headers['content-length']) >
          uploadLimit(request.headers['content-type']?.split(';')[0])
        )
          throw new FileError(413, 'FILE_TOO_LARGE', 'Превышен допустимый размер файла');
        uploads++;
        try {
          return json(201, {
            success: true,
            data: await service.upload(
              userId,
              url.searchParams.get('projectId'),
              await readBytes(request, uploadLimit(request.headers['content-type']?.split(';')[0])),
              request.headers['content-type']?.split(';')[0] ?? 'application/octet-stream',
              url.searchParams.get('fileName') ?? 'file',
            ),
          });
        } finally {
          uploads--;
        }
      }
      const match = /^\/api\/v1\/files\/([^/]+)(\/content|\/deletion)?$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        if (match[2] === '/deletion')
          return json(200, { success: true, data: await service.deleteStatus(match[1], userId) });
        if (!match[2])
          return json(200, {
            success: true,
            data: await service.metadata(match[1], userId),
          });
        const { file, response: stored } = await service.content(match[1], userId);
        const bytes = await readBytes(stored.body, uploadLimit(file.mimeType));
        if (
          bytes.length !== file.sizeBytes ||
          (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        )
          throw new FileError(
            502,
            'STORAGE_INVALID_RESPONSE',
            'Размер файла в хранилище изменился',
          );
        response.writeHead(200, {
          'Content-Type': file.mimeType,
          'Content-Length': bytes.length,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition':
            file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')
              ? 'inline'
              : `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName ?? 'file')}`,
        });
        return response.end(bytes);
      }
      if (match && !match[2] && request.method === 'DELETE')
        return json(202, { success: true, data: await service.delete(match[1], userId) });
      // В интеграции Timepost удаление остаётся запрещено до учёта ссылок из постов.
      throw new FileError(404, 'NOT_FOUND', 'Маршрут не найден');
    } catch (error) {
      request.resume();
      json(error instanceof FileError ? error.status : 503, {
        success: false,
        error: {
          code: error instanceof FileError ? error.code : 'FILES_UNAVAILABLE',
          message:
            error instanceof FileError ? error.message : 'Файловый сервис временно недоступен',
        },
      });
    }
  };
}
