import type { OpenAPIV3 } from 'openapi-types';
const envelope = (schema: OpenAPIV3.SchemaObject): OpenAPIV3.SchemaObject => ({
  type: 'object',
  required: ['success', 'data'],
  properties: { success: { type: 'boolean', enum: [true] }, data: schema },
});
const uploadId: OpenAPIV3.SchemaObject = { type: 'string', format: 'uuid' };
const parts: OpenAPIV3.SchemaObject = {
  type: 'array',
  maxItems: 10000,
  items: {
    type: 'object',
    required: ['partNumber', 'etag'],
    properties: {
      partNumber: { type: 'integer', minimum: 1, maximum: 10000 },
      etag: { type: 'string', maxLength: 200 },
    },
  },
};
function post(
  operationId: string,
  summary: string,
  body: OpenAPIV3.SchemaObject,
  data: OpenAPIV3.SchemaObject,
  status = '200',
): OpenAPIV3.OperationObject {
  return {
    operationId,
    summary,
    description:
      'Требуется доступ на запись в проект. Только Yandex Object Storage со статическими серверными ключами. Presigned URL — временное разрешение, секретный ключ браузеру не передаётся.',
    requestBody: { required: true, content: { 'application/json': { schema: body } } },
    responses: {
      [status]: {
        description: 'Результат',
        content: { 'application/json': { schema: envelope(data) } },
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 415, 429, 502, 503].map((code) => [
          code,
          {
            description: 'Отказ доступа, лимита, формата или зависимости',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/FileError' } } },
          },
        ]),
      ),
    },
  };
}
export const directUploadPaths: OpenAPIV3.PathsObject = {
  '/api/v1/media/upload/init': {
    post: post(
      'initMediaUpload',
      'Зарезервировать квоту и получить presigned PUT или multipart-сессию',
      {
        type: 'object',
        required: ['projectId', 'fileName', 'mimeType', 'sizeBytes'],
        properties: {
          projectId: { type: 'string', pattern: '^[0-9]+$' },
          fileName: { type: 'string', maxLength: 255 },
          mimeType: {
            type: 'string',
            enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'],
          },
          sizeBytes: { type: 'integer', minimum: 1, maximum: 10000000000 },
          socialNetwork: { type: 'string', enum: ['instagram'] },
        },
      },
      {
        type: 'object',
        required: ['uploadId', 'mode', 'expiresAt'],
        properties: {
          uploadId,
          mode: { type: 'string', enum: ['put', 'multipart'] },
          expiresAt: { type: 'string', format: 'date-time' },
          uploadUrl: { type: 'string', format: 'uri' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          partSize: { type: 'integer' },
          partCount: { type: 'integer' },
        },
      },
      '201',
    ),
  },
  '/api/v1/media/upload/part': {
    post: post(
      'signMediaPart',
      'Получить presigned PUT части (16 MiB; последняя короче)',
      {
        type: 'object',
        required: ['uploadId', 'partNumber'],
        properties: { uploadId, partNumber: { type: 'integer', minimum: 1, maximum: 10000 } },
      },
      {
        type: 'object',
        required: ['url', 'headers'],
        properties: {
          url: { type: 'string', format: 'uri' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    ),
  },
  '/api/v1/media/upload/complete': {
    post: {
      ...post(
        'completeMediaUpload',
        'Проверить объект и перенести incoming → media',
        { type: 'object', required: ['uploadId'], properties: { uploadId, parts } },
        { type: 'object' },
      ),
      description:
        'Повтор после успешного завершения возвращает тот же файл. Проверяются серверные размеры/ETag всех частей, metadata и фактический формат (JPEG/PNG/WebP, MP4 H.264/AAC, WebM VP8/VP9). Проверка потока через локальный временный файл ограничена 20 минутами, одновременно максимум две проверки на процесс. SHA-256 и постоянный object_key сохраняются в БД; presigned URL в БД не сохраняется.',
    },
  },
  '/api/v1/media/upload/cancel': {
    post: post(
      'cancelMediaUpload',
      'Поставить незавершённую загрузку в очередь удаления',
      { type: 'object', required: ['uploadId'], properties: { uploadId } },
      { type: 'object', properties: { uploadId, status: { type: 'string', enum: ['deleting'] } } },
      '202',
    ),
  },
  '/api/v1/files/{id}/download': {
    get: {
      operationId: 'signMediaDownload',
      summary: 'Получить приватную ссылку GET на 15 минут',
      parameters: [{ in: 'path', name: 'id', required: true, schema: uploadId }],
      responses: {
        200: {
          description: 'Подписанная ссылка после проверки доступа к проекту',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                required: ['url', 'expiresIn'],
                properties: {
                  url: { type: 'string', format: 'uri' },
                  expiresIn: { type: 'integer', enum: [900] },
                },
              }),
            },
          },
        },
      },
    },
  },
};
