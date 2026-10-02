import { requestTiming } from '../../../../shared/infrastructure/request-context.js';
import { contentRange } from './content-range.js';
import { isRecord } from '../../../../shared/guards/is-record.js';
import { idPattern } from '../../domain/file-policy.js';
import { fileErrorStatus } from './error-status.js';
import { publicMetadata } from './file-metadata.js';
import type { FileHttpOptions } from './contracts.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authorization } from '../../../access/contracts.js';
import type { FileService } from '../../application/file-service.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { FileError } from '../../../../shared/application/file-error.js';
import { maxBytes, maxVideoBytes, uploadLimit } from '../../domain/file-policy.js';

async function readBytes(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null,
  limit = maxBytes,
) {
  if (!source) throw new FileError('STORAGE_INVALID_RESPONSE', 'Хранилище вернуло пустой поток');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > limit) throw new FileError('FILE_TOO_LARGE', 'Превышен допустимый размер файла');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createHandler(
  service: FileService,
  authenticate: Authorization['authenticate'],
  ready: () => Promise<void>,
  options: FileHttpOptions,
) {
  let uploads = 0;
  let downloads = 0;
  return async (request: IncomingMessage, response: ServerResponse) => {
    let countedDownload = false;
    const json = (status: number, value: unknown) => {
      response.writeHead(status, {
        'Server-Timing': requestTiming(),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? '/', 'http://files');
      if (request.method === 'GET' && url.pathname === '/health/ready') {
        await ready();
        return json(200, { status: 'ok' });
      }
      if (
        request.method === 'GET' &&
        options.uiEnabled &&
        ['/', '/app.js', '/style.css'].includes(url.pathname)
      ) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = (
          {
            'index.html': 'text/html; charset=utf-8',
            'app.js': 'text/javascript; charset=utf-8',
            'style.css': 'text/css; charset=utf-8',
          } as Record<string, string>
        )[name]!;
        response.writeHead(200, {
          'Server-Timing': requestTiming(),
          'Content-Type': type,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        });
        return response.end(await readFile(new URL(name, options.staticDirectory)));
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/internal/file-references') {
        if (!options.authenticateReferences || !options.referenceRepository)
          throw new FileError('NOT_FOUND', 'Маршрут не найден');
        await options.authenticateReferences(request.headers.authorization);
        let body: unknown;
        try {
          body = JSON.parse((await readBytes(request, 16384)).toString());
        } catch {
          throw new FileError('INVALID_FILE_ID', 'Неверное тело запроса');
        }
        if (
          !isRecord(body) ||
          typeof body.projectId !== 'string' ||
          !/^\d+$/.test(body.projectId) ||
          typeof body.referenceId !== 'string' ||
          !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.referenceId) ||
          !Array.isArray(body.fileIds) ||
          body.fileIds.length > 100 ||
          body.fileIds.some((id) => typeof id !== 'string' || !idPattern.test(id)) ||
          (body.cleanupRemoved !== undefined && typeof body.cleanupRemoved !== 'boolean')
        )
          throw new FileError('INVALID_FILE_ID', 'Неверная привязка файлов');
        await options.referenceRepository.replaceReferences({
          projectId: body.projectId,
          referenceId: body.referenceId,
          fileIds: [...new Set((body.fileIds as string[]).map((id) => id.toLowerCase()))],
          cleanupRemoved: body.cleanupRemoved === true,
        });
        return json(200, { success: true, data: { referenceId: body.referenceId } });
      }
      const userId = await authenticate(request.headers.authorization);
      if (request.method === 'GET' && url.pathname === '/api/v1/storage')
        return json(200, {
          success: true,
          data: {
            provider: options.storageProvider ?? 'yandex',
            authMode: options.authMode ?? 'timepost',
            maxBytes,
            maxVideoBytes,
            genericFiles: options.genericFiles === true,
            deleteEnabled: options.deleteEnabled === true,
          },
        });
      if (request.method === 'GET' && url.pathname === '/api/v1/files') {
        const page = await service.list(
          userId,
          url.searchParams.get('projectId'),
          url.searchParams.get('limit') ?? '20',
          url.searchParams.get('cursor'),
        );
        return json(200, {
          success: true,
          data: {
            ...page,
            items: page.items.map((file) => publicMetadata(file, options.contentPrefix)),
          },
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/files') {
        if (uploads >= 4) throw new FileError('UPLOAD_BUSY', 'Повторите загрузку позже');
        if (
          !options.genericFiles &&
          !['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(
            request.headers['content-type']?.split(';')[0] ?? '',
          )
        )
          throw new FileError('INVALID_IMAGE', 'Неподдерживаемый тип фотографии');
        if (
          Number(request.headers['content-length']) >
          uploadLimit(request.headers['content-type']?.split(';')[0])
        )
          throw new FileError('FILE_TOO_LARGE', 'Превышен допустимый размер файла');
        uploads++;
        try {
          return json(201, {
            success: true,
            data: publicMetadata(
              await service.upload(
                userId,
                url.searchParams.get('projectId'),
                await readBytes(
                  request,
                  uploadLimit(request.headers['content-type']?.split(';')[0]),
                ),
                request.headers['content-type']?.split(';')[0] ?? 'application/octet-stream',
                url.searchParams.get('fileName') ?? 'file',
              ),
              options.contentPrefix,
            ),
          });
        } finally {
          uploads--;
        }
      }
      const match = /^\/api\/v1\/files\/([^/]+)(\/content|\/deletion|\/thumbnail)?$/.exec(
        url.pathname,
      );
      if (match && request.method === 'GET') {
        if (match[2] === '/deletion')
          return json(200, { success: true, data: await service.deleteStatus(match[1]!, userId) });
        if (!match[2])
          return json(200, {
            success: true,
            data: publicMetadata(await service.metadata(match[1]!, userId), options.contentPrefix),
          });
        if (downloads >= 4) throw new FileError('UPLOAD_BUSY', 'Повторите скачивание позже');
        downloads++;
        countedDownload = true;
        const { file, stream } = await service.content(match[1]!, userId);
        const bytes = await readBytes(stream, uploadLimit(file.mimeType));
        if (
          bytes.length !== file.sizeBytes ||
          (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        )
          throw new FileError('STORAGE_INVALID_RESPONSE', 'Размер файла в хранилище изменился');
        if (match[2] === '/thumbnail') {
          const thumbnail = await service.thumbnail(bytes, file.mimeType);
          response.writeHead(200, {
            'Server-Timing': requestTiming(),
            'Content-Type': 'image/webp',
            'Content-Length': thumbnail.length,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          return response.end(thumbnail);
        }
        const range = contentRange(request.headers.range, bytes.length);
        if (range === false) {
          response.writeHead(416, {
            'Server-Timing': requestTiming(),
            'Content-Range': `bytes */${bytes.length}`,
            'Cache-Control': 'private, no-store',
          });
          return response.end();
        }
        const payload = range ? bytes.subarray(range.start, range.end + 1) : bytes;
        response.writeHead(range ? 206 : 200, {
          'Server-Timing': requestTiming(),
          'Accept-Ranges': 'bytes',
          ...(range
            ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` }
            : {}),
          'Content-Type': file.mimeType,
          'Content-Length': payload.length,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition':
            file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')
              ? 'inline'
              : `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName ?? 'file')}`,
        });
        return response.end(payload);
      }
      if (match && !match[2] && request.method === 'DELETE')
        return json(202, { success: true, data: await service.delete(match[1]!, userId) });
      // Ссылки из постов учитываются внутренним маршрутом с отдельным сервисным токеном.
      throw new FileError('NOT_FOUND', 'Маршрут не найден');
    } catch (error) {
      request.resume();
      json(error instanceof FileError ? fileErrorStatus[error.code] : 503, {
        success: false,
        error: {
          code: error instanceof FileError ? error.code : 'FILES_UNAVAILABLE',
          message:
            error instanceof FileError ? error.message : 'Файловый сервис временно недоступен',
        },
      });
    } finally {
      if (countedDownload) downloads--;
    }
  };
}
