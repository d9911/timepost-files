import { publicUiAsset } from './ui-assets.js';
import { storageAdminRoute } from './storage-admin-handler.js';
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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { multipartThreshold, partSize } from '../../application/direct-upload-service.js';

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
      const uiAsset = options.uiEnabled ? publicUiAsset(url.pathname) : undefined;
      if (request.method === 'GET' && uiAsset) {
        response.writeHead(200, {
          'Server-Timing': requestTiming(),
          'Content-Type': uiAsset.contentType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; connect-src 'self' https://storage.yandexcloud.net https://*.storage.yandexcloud.net; manifest-src 'self'; worker-src 'self'",
        });
        return response.end(await readFile(new URL(uiAsset.name, options.staticDirectory)));
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/internal/publication-media') {
        if (
          !options.authenticateReferences ||
          !options.referenceRepository?.referencedFile ||
          !options.directUploads
        )
          throw new FileError('NOT_FOUND', 'Маршрут не найден');
        await options.authenticateReferences(request.headers.authorization);
        let body: unknown;
        try {
          body = JSON.parse((await readBytes(request, 2048)).toString());
        } catch {
          throw new FileError('INVALID_FILE_ID', 'Неверный запрос');
        }
        if (
          !isRecord(body) ||
          typeof body.projectId !== 'string' ||
          !/^\d+$/.test(body.projectId) ||
          typeof body.referenceId !== 'string' ||
          !/^post:\d+$/.test(body.referenceId) ||
          typeof body.fileId !== 'string' ||
          !idPattern.test(body.fileId)
        )
          throw new FileError('INVALID_FILE_ID', 'Неверная привязка файла');
        const file = await options.referenceRepository.referencedFile(
          body.projectId,
          body.referenceId,
          body.fileId,
        );
        if (!file) throw new FileError('FILE_NOT_FOUND', 'Файл не привязан к публикации');
        return json(200, { success: true, data: await options.directUploads.downloadUrl(file) });
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
      if (url.pathname.startsWith('/api/v1/admin/storage/')) {
        if (!options.storageAdminService || !options.authenticateStorageAdmin)
          throw new FileError('NOT_FOUND', 'Маршрут не найден');
        const actor = await options.authenticateStorageAdmin(request.headers.authorization);
        return json(200, {
          success: true,
          data: await storageAdminRoute(request, url, actor, options.storageAdminService),
        });
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
            directUploads: Boolean(options.directUploads),
            maxFileBytes:
              options.directUploads && options.maxFileBytes
                ? await options.maxFileBytes(userId)
                : maxVideoBytes,
            multipartThreshold,
            partSize,
            genericFiles: options.genericFiles === true,
            deleteEnabled: options.deleteEnabled === true,
          },
        });
      if (request.method === 'POST' && url.pathname.startsWith('/api/v1/media/upload/')) {
        const direct = options.directUploads;
        if (!direct)
          throw new FileError('STORAGE_NOT_CONFIGURED', 'Прямая загрузка S3 не настроена');
        let body: unknown;
        try {
          body = JSON.parse((await readBytes(request, 256 * 1024)).toString());
        } catch {
          throw new FileError('INVALID_FILE_ID', 'Неверное тело запроса');
        }
        if (!isRecord(body)) throw new FileError('INVALID_FILE_ID', 'Неверное тело запроса');
        if (url.pathname === '/api/v1/media/upload/init') {
          if (
            typeof body.projectId !== 'string' ||
            typeof body.fileName !== 'string' ||
            typeof body.mimeType !== 'string' ||
            typeof body.sizeBytes !== 'number' ||
            (body.socialNetwork !== undefined && typeof body.socialNetwork !== 'string')
          )
            throw new FileError('INVALID_FILE_ID', 'Неверные параметры загрузки');
          return json(201, {
            success: true,
            data: await direct.init(userId, {
              projectId: body.projectId,
              fileName: body.fileName,
              mimeType: body.mimeType,
              sizeBytes: body.sizeBytes,
              socialNetwork: body.socialNetwork,
            }),
          });
        }
        if (typeof body.uploadId !== 'string')
          throw new FileError('INVALID_FILE_ID', 'Требуется uploadId');
        if (url.pathname === '/api/v1/media/upload/part') {
          if (typeof body.partNumber !== 'number')
            throw new FileError('INVALID_FILE_ID', 'Требуется partNumber');
          return json(200, {
            success: true,
            data: await direct.part(userId, body.uploadId, body.partNumber),
          });
        }
        if (url.pathname === '/api/v1/media/upload/complete') {
          if (
            body.parts !== undefined &&
            (!Array.isArray(body.parts) ||
              body.parts.length > 10000 ||
              body.parts.some(
                (part) =>
                  !isRecord(part) ||
                  typeof part.partNumber !== 'number' ||
                  typeof part.etag !== 'string' ||
                  part.etag.length > 200,
              ))
          )
            throw new FileError('INVALID_FILE_ID', 'Неверные части загрузки');
          return json(200, {
            success: true,
            data: publicMetadata(
              await direct.complete(
                userId,
                body.uploadId,
                body.parts as { partNumber: number; etag: string }[] | undefined,
              ),
              options.contentPrefix,
            ),
          });
        }
        if (url.pathname === '/api/v1/media/upload/cancel')
          return json(202, { success: true, data: await direct.cancel(userId, body.uploadId) });
        throw new FileError('NOT_FOUND', 'Маршрут не найден');
      }
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
      const match =
        /^\/api\/v1\/files\/([^/]+)(\/content|\/deletion|\/thumbnail|\/download)?$/.exec(
          url.pathname,
        );
      if (match && request.method === 'GET') {
        if (match[2] === '/download') {
          if (!options.directUploads)
            throw new FileError('STORAGE_NOT_CONFIGURED', 'Подписанные ссылки не настроены');
          return json(200, {
            success: true,
            data: await options.directUploads.downloadUrl(
              await service.metadata(match[1]!, userId),
            ),
          });
        }
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
        if (match[2] === '/thumbnail' && options.directUploads) {
          const file = await service.metadata(match[1]!, userId);
          if (file.objectKey) {
            const thumbnail = await options.directUploads.thumbnail(file);
            response.writeHead(200, {
              'Content-Type': 'image/webp',
              'Content-Length': thumbnail.length,
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            return response.end(thumbnail);
          }
        }
        if (match[2] === '/content' && options.directUploads) {
          const file = await service.metadata(match[1]!, userId);
          if (file.objectKey) {
            const range = contentRange(request.headers.range, file.sizeBytes);
            if (range === false) {
              response.writeHead(416, { 'Content-Range': `bytes */${file.sizeBytes}` });
              return response.end();
            }
            const stream = await options.directUploads.content(
              file,
              range ? `bytes=${range.start}-${range.end}` : undefined,
            );
            response.writeHead(range ? 206 : 200, {
              'Content-Type': file.mimeType,
              'Content-Length': range ? range.end - range.start + 1 : file.sizeBytes,
              'Accept-Ranges': 'bytes',
              ...(range
                ? { 'Content-Range': `bytes ${range.start}-${range.end}/${file.sizeBytes}` }
                : {}),
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
              'Server-Timing': requestTiming(),
            });
            await pipeline(Readable.from(stream), response, {
              signal: AbortSignal.timeout(20 * 60 * 1000),
            });
            return;
          }
        }
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
      if (response.headersSent) {
        response.destroy();
        return;
      }
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
