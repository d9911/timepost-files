import type { OpenAPIV3 } from 'openapi-types';
const errorResponse: OpenAPIV3.ResponseObject = {
  description: 'Ошибка проверки доступа, входных данных или зависимости',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/FileError' } },
  },
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 502, 503].map((status) => [status, errorResponse]),
);
const metadataResponse: OpenAPIV3.ResponseObject = {
  description: 'Подтверждённый файл',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['success', 'data'],
        properties: {
          success: { type: 'boolean', enum: [true] },
          data: { $ref: '#/components/schemas/StoredFile' },
        },
      },
    },
  },
};
const idParameter: OpenAPIV3.ParameterObject = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export const fileOperations = [
  { method: 'post', path: '/api/v1/files' },
  { method: 'get', path: '/api/v1/files' },
  { method: 'get', path: '/api/v1/storage' },
  { method: 'delete', path: '/api/v1/files/{id}' },
  { method: 'get', path: '/api/v1/files/{id}/deletion' },
  { method: 'get', path: '/api/v1/files/{id}' },
  { method: 'get', path: '/api/v1/files/{id}/content' },
  { method: 'get', path: '/api/v1/files/{id}/thumbnail' },
  { method: 'post', path: '/api/v1/internal/file-references' },
  { method: 'get', path: '/health/ready' },
];

export const fileOpenApi: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Timepost Files API',
    version: '0.3.0',
    description:
      'Приватные файлы проектов. Провайдеры: Яндекс Диск, Selectel S3, Amazon S3, Yandex Object Storage, совместимый S3 endpoint и локальный симулятор; метаданные и очередь удаления — PostgreSQL. Авторизация: Timepost (Accounts/Projects) либо автономные bearer API keys. Удаление в Timepost требует учтённый файл без ссылок; автономное удаление доступно владельцу. Публичных ссылок нет. Swagger доступен только как локальный артефакт.',
  },
  servers: [{ url: 'http://localhost:3050' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/v1/files': {
      post: {
        operationId: 'uploadPhoto',
        summary: 'Загрузить файл проекта',
        description:
          'Сырой бинарный файл; multipart и base64 не принимаются. В режиме genericFiles=true также принимаются произвольные файлы как application/octet-stream; они скачиваются как attachment. Только активный проект и роли OWNER/ADMIN/MEMBER. Фото: максимум 10 МиБ, 4096×4096, один кадр. Видео: 100 МиБ, 4096×4096, 60 минут; MP4 H.264/AAC или WebM VP8/VP9. Контейнер, кодеки и размеры проверяет ffprobe; полного декодирования и транскодирования видео нет. Неуспешная загрузка не выдаётся как готовый файл.',
        parameters: [
          {
            name: 'fileName',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 255 },
            description:
              'Имя для скачивания; управляющие символы запрещены. Не используется как путь хранения.',
          },
          {
            name: 'projectId',
            in: 'query',
            required: true,
            schema: { type: 'string', pattern: '^\\d+$' },
          },
        ],
        requestBody: {
          required: true,
          content: Object.fromEntries(
            [
              'image/jpeg',
              'image/png',
              'image/webp',
              'video/mp4',
              'video/webm',
              'application/octet-stream',
            ].map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]),
          ),
        },
        responses: { 201: metadataResponse, ...errors },
      },
    },
    '/api/v1/files/{id}': {
      get: {
        operationId: 'getFileMetadata',
        summary: 'Получить метаданные доступного файла',
        parameters: [idParameter],
        responses: { 200: metadataResponse, ...errors },
      },
    },
    '/api/v1/files/{id}/content': {
      get: {
        operationId: 'getFileContent',
        summary: 'Прочитать приватный файл',
        description:
          'Требуется Bearer сессия и участие в проекте. Ответ не кэшируется. В браузере нужно авторизованно получить Blob; обычный img/video без сессии не работает. Видео выдаётся inline; Range/resumable не реализованы, клиент получает ограниченный Blob.',
        parameters: [idParameter],
        responses: {
          200: {
            description: 'Файл',
            content: Object.fromEntries(
              [
                'image/jpeg',
                'image/png',
                'image/webp',
                'video/mp4',
                'video/webm',
                'application/octet-stream',
              ].map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]),
            ),
          },
          ...errors,
        },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'filesReady',
        summary: 'Проверить БД и готовность выбранного хранилища',
        description:
          'Проверяет выбранного провайдера: для S3 — доступ к бакету и отсутствие versioning; ключи и endpoint в ответе не раскрываются.',
        security: [],
        responses: {
          200: {
            description: 'БД и выбранное хранилище доступны',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: { status: { type: 'string', enum: ['ok'] } },
                },
              },
            },
          },
          503: errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      StoredFile: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'mediaFileId',
          'projectId',
          'url',
          'mimeType',
          'width',
          'height',
          'sizeBytes',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          mediaFileId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', pattern: '^\\d+$' },
          url: {
            type: 'string',
            description: 'Приватный путь через same-origin proxy; не внешняя публичная ссылка.',
          },
          mimeType: {
            type: 'string',
            enum: [
              'image/jpeg',
              'image/png',
              'image/webp',
              'video/mp4',
              'video/webm',
              'application/octet-stream',
            ],
          },
          width: { type: 'integer', nullable: true, minimum: 1, maximum: 4096 },
          height: { type: 'integer', nullable: true, minimum: 1, maximum: 4096 },
          fileName: { type: 'string', maxLength: 255 },
          sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          storageProvider: {
            type: 'string',
            enum: ['yandex', 'simulator', 's3', 'selectel', 'aws', 'yandex-object'],
          },
          createdAt: { type: 'string', format: 'date-time' },
          durationSeconds: { type: 'number', minimum: 0, maximum: 3600 },
          sizeBytes: { type: 'integer', minimum: 1, maximum: 104857600 },
        },
      },
      FileError: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'INVALID_PROJECT',
                  'INVALID_FILE_ID',
                  'INVALID_FILE_NAME',
                  'INVALID_PAGINATION',
                  'DELETE_DISABLED',
                  'STORAGE_PROVIDER_MISMATCH',
                  'UNAUTHORIZED',
                  'PROJECT_FORBIDDEN',
                  'AUTH_DEPENDENCY_UNAVAILABLE',
                  'FILE_TOO_LARGE',
                  'INVALID_IMAGE',
                  'INVALID_VIDEO',
                  'VIDEO_PROCESSOR_UNAVAILABLE',
                  'FILE_NOT_FOUND',
                  'FILE_FORBIDDEN',
                  'FILE_DELETING',
                  'UPLOAD_BUSY',
                  'NOT_FOUND',
                  'FILES_UNAVAILABLE',
                  'STORAGE_NOT_CONFIGURED',
                  'STORAGE_OPERATION_PENDING',
                  'STORAGE_UNAVAILABLE',
                  'STORAGE_INVALID_RESPONSE',
                ],
              },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

fileOpenApi.paths['/api/v1/files']!.get = {
  operationId: 'listFiles',
  summary: 'Список файлов проекта с курсором',
  description:
    'Только ready-файлы текущего провайдера и доступного проекта. Автономный основной ключ имеет доступ ко всем проектам, readonly-ключ только читает; это не модель отдельных пользователей.',
  parameters: [
    {
      name: 'projectId',
      in: 'query',
      required: true,
      schema: { type: 'string', pattern: '^\\d+$' },
    },
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
  ],
  responses: {
    ...errors,
    200: {
      description: 'Страница списка; cursor — последний ID, не номер страницы.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', enum: [true] },
              data: {
                type: 'object',
                required: ['items', 'nextCursor'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/StoredFile' } },
                  nextCursor: { type: 'string', format: 'uuid', nullable: true },
                },
              },
            },
          },
        },
      },
    },
  },
};
fileOpenApi.paths['/api/v1/files/{id}']!.delete = {
  operationId: 'deleteFile',
  summary: 'Поставить окончательное удаление файла в очередь',
  parameters: [idParameter],
  description:
    'Требуется FILES_DELETE_ENABLED=true. В Timepost загрузивший пользователь должен иметь право записи; допускаются новые после миграции файлы без ссылок, включая ещё не привязанные загрузки. Файлы до миграции учёта защищены даже после регистрации до полной сверки старых ссылок. 202 означает очередь; файл перестаёт читаться сразу, worker удаляет байты и фиксирует deleted. Повтор допускается в deleting; после завершения 404. Worker повторяет сбои до 10 попыток; failed требует вмешательства оператора.',
  responses: {
    ...errors,
    202: {
      description: 'Удаление принято, байты ещё могут находиться у провайдера.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success', 'data'],
            properties: {
              success: { type: 'boolean', enum: [true] },
              data: {
                type: 'object',
                required: ['id', 'status'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  status: { type: 'string', enum: ['deleting'] },
                },
              },
            },
          },
        },
      },
    },
  },
};
fileOpenApi.paths['/api/v1/storage'] = {
  get: {
    operationId: 'getStorageConfiguration',
    summary: 'Прочитать безопасную конфигурацию хранилища',
    description:
      'Нужен пользовательский bearer или API key. OAuth, ключи, DB URL и системные JWT никогда не возвращаются. Настройка провайдера выполняется серверным окружением, не этим API.',
    responses: {
      ...errors,
      200: {
        description: 'Текущий режим и возможности.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success', 'data'],
              properties: {
                success: { type: 'boolean', enum: [true] },
                data: {
                  type: 'object',
                  required: [
                    'provider',
                    'authMode',
                    'maxBytes',
                    'maxVideoBytes',
                    'genericFiles',
                    'deleteEnabled',
                  ],
                  properties: {
                    provider: {
                      type: 'string',
                      enum: ['yandex', 'simulator', 's3', 'selectel', 'aws', 'yandex-object'],
                    },
                    authMode: { type: 'string', enum: ['timepost', 'api-key'] },
                    maxBytes: { type: 'integer', enum: [10485760] },
                    maxVideoBytes: { type: 'integer', enum: [104857600] },
                    genericFiles: { type: 'boolean' },
                    deleteEnabled: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

fileOpenApi.paths['/api/v1/files/{id}/deletion'] = {
  get: {
    operationId: 'getFileDeletion',
    summary: 'Прочитать состояние очереди удаления',
    parameters: [idParameter],
    description:
      'Проверяется доступ к проекту. Доступно после окончания удаления; 404, если задания нет. Повторный DELETE владельцем перезапускает только failed-задание; running не сбрасывается.',
    responses: {
      ...errors,
      200: {
        description: 'Состояние и число попыток, без ответов и секретов провайдера.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success', 'data'],
              properties: {
                success: { type: 'boolean', enum: [true] },
                data: {
                  type: 'object',
                  required: ['fileId', 'status', 'attempts', 'maxAttempts'],
                  properties: {
                    fileId: { type: 'string', format: 'uuid' },
                    status: { type: 'string', enum: ['pending', 'running', 'done', 'failed'] },
                    attempts: { type: 'integer', minimum: 0 },
                    maxAttempts: { type: 'integer', enum: [10] },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

fileOpenApi.paths['/api/v1/internal/file-references'] = {
  post: {
    operationId: 'replaceFileReferences',
    summary: 'Заменить ссылки поста на файлы',
    description:
      'Только Timepost: HS256 system JWT, serviceId=posts-service, tokenType=system, permissions=[files:references:write], настроенные SYSTEM_JWT issuer/audience. Замена идемпотентна; блокировки сериализуют привязку и удаление. cleanupRemoved=true удаляет только новые после миграции ранее привязанные файлы без оставшихся ссылок. Старые файлы требуют полного backfill. Освобождение выполнять после commit удаления поста; сбой сохранения безопасно удерживает файл до сверки.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['projectId', 'referenceId', 'fileIds'],
            properties: {
              projectId: { type: 'string', pattern: '^[0-9]+$' },
              referenceId: { type: 'string', pattern: '^[a-zA-Z0-9:_-]{1,160}$' },
              fileIds: { type: 'array', maxItems: 100, items: { type: 'string', format: 'uuid' } },
              cleanupRemoved: { type: 'boolean', default: false },
            },
          },
        },
      },
    },
    responses: {
      ...errors,
      200: {
        description: 'Ссылки сохранены',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success', 'data'],
              properties: {
                success: { type: 'boolean', enum: [true] },
                data: {
                  type: 'object',
                  required: ['referenceId'],
                  properties: { referenceId: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};
fileOpenApi.paths['/api/v1/files/{id}/thumbnail'] = {
  get: {
    operationId: 'downloadFileThumbnail',
    summary: 'Приватная миниатюра фотографии',
    description:
      'WebP до 512×512 без увеличения. Доступ и SHA-256 исходника проверяются полностью. Видео не поддерживается; исходник читается целиком, кеша и фоновой генерации нет.',
    parameters: [idParameter],
    responses: {
      ...errors,
      200: {
        description: 'Миниатюра',
        content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } },
      },
    },
  },
};
const download = fileOpenApi.paths['/api/v1/files/{id}/content']?.get;
if (download) {
  download.parameters = [
    ...(download.parameters ?? []),
    {
      name: 'Range',
      in: 'header',
      required: false,
      schema: { type: 'string' },
      description:
        'Один byte-range либо суффикс. Полное чтение и checksum исходника выполняются до выдачи; multipart не поддерживается.',
    },
  ];
  download.responses['206'] = {
    description: 'Частичное содержимое; Content-Range, Accept-Ranges: bytes',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  };
  download.responses['416'] = { description: 'Неверный диапазон; Content-Range: bytes */размер' };
}
for (const path of Object.values(fileOpenApi.paths)) {
  if (!path) continue;
  for (const method of ['get', 'post', 'delete'] as const) {
    const operation = path[method];
    if (!operation) continue;
    for (const response of Object.values(operation.responses)) {
      if ('$ref' in response) continue;
      response.headers = {
        ...response.headers,
        'X-Request-Id': {
          description: 'Проверенный идентификатор корреляции',
          schema: { type: 'string' },
        },
        'Server-Timing': {
          description: 'Время обработки API до отправки ответа',
          schema: { type: 'string', example: 'app;dur=12.30' },
        },
      };
    }
  }
}
