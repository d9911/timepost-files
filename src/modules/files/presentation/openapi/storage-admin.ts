import type { OpenAPIV3 } from 'openapi-types';
const user: OpenAPIV3.ParameterObject = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
};
const plan: OpenAPIV3.ParameterObject = {
  name: 'planId',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['start', 'pro', 'business'] },
};
const error: OpenAPIV3.ResponseObject = {
  description: 'Нет административного доступа, неверные данные или сервис недоступен',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/FileError' } } },
};
const settings: OpenAPIV3.SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'planId',
    'maxFileBytes',
    'quotaBytes',
    'concurrentUploads',
    'retentionDays',
    'uploadsEnabled',
    'retentionEnabled',
  ],
  properties: {
    planId: { type: 'string', enum: ['start', 'pro', 'business'] },
    maxFileBytes: { type: 'integer', nullable: true, minimum: 1, maximum: 10000000000 },
    quotaBytes: { type: 'integer', nullable: true, minimum: 0, maximum: 9007199254740991 },
    concurrentUploads: { type: 'integer', nullable: true, minimum: 1, maximum: 32 },
    retentionDays: { type: 'integer', nullable: true, minimum: 1, maximum: 3650 },
    uploadsEnabled: { type: 'boolean' },
    retentionEnabled: { type: 'boolean' },
  },
};
function operation(
  operationId: string,
  summary: string,
  parameters: OpenAPIV3.ParameterObject[] = [],
  body?: OpenAPIV3.SchemaObject,
): OpenAPIV3.OperationObject {
  return {
    operationId,
    summary,
    description:
      'Только системный HS256 JWT admin-service с files:admin и числовым sub администратора. Срок токена не больше 60 секунд. Пользовательские токены сюда не принимаются. Обёртка ответа: success=true, data. Настройки хранения не являются подтверждением оплаты тарифа.',
    security: [{ bearerAuth: [] }],
    parameters,
    ...(body
      ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } }
      : {}),
    responses: {
      200: {
        description: 'Данные или подтверждённая операция',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['success', 'data'],
              properties: {
                success: { type: 'boolean', enum: [true] },
                data: {
                  oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
                  description:
                    'Результат соответствующей операции; plans возвращает массив профилей.',
                },
              },
            },
          },
        },
      },
      400: error,
      401: error,
      404: error,
      413: error,
      503: error,
    },
  };
}
export const storageAdminPaths: OpenAPIV3.PathsObject = {
  '/api/v1/admin/storage/summary': {
    get: operation(
      'storageAdminSummary',
      'Объём учтённых файлов провайдера: usedBytes, reservedBytes, fileCount, pendingCount, deletingCount; physicalBucketBytes=null',
    ),
  },
  '/api/v1/admin/storage/plans': {
    get: operation(
      'storageAdminPlans',
      'Массив профилей хранения в data, включая версию и ограничения',
    ),
  },
  '/api/v1/admin/storage/plans/{planId}': {
    put: operation(
      'storageAdminUpdatePlan',
      'Обновить профиль хранения; максимальный размер, параллелизм и срок обязательны и не могут быть null',
      [plan],
      {
        ...settings,
        properties: {
          ...settings.properties,
          maxFileBytes: { type: 'integer', minimum: 1, maximum: 10000000000 },
          concurrentUploads: { type: 'integer', minimum: 1, maximum: 32 },
          retentionDays: { type: 'integer', minimum: 1, maximum: 3650 },
        },
      },
    ),
  },
  '/api/v1/admin/storage/users': {
    get: operation(
      'storageAdminUsers',
      'До 50 пользователей с объёмом и числом фото/видео; items и nextCursor',
      [
        { name: 'cursor', in: 'query', schema: { type: 'string', pattern: '^[1-9][0-9]*$' } },
        { name: 'userId', in: 'query', schema: { type: 'string', pattern: '^[1-9][0-9]*$' } },
      ],
    ),
  },
  '/api/v1/admin/storage/users/{userId}': {
    get: operation(
      'storageAdminUserSettings',
      'Индивидуальные settings и действующая effective политика',
      [user],
    ),
    put: operation(
      'storageAdminUpdateUser',
      'Сохранить настройки пользователя; null наследует профиль',
      [user],
      settings,
    ),
  },
  '/api/v1/admin/storage/users/{userId}/cleanup-preview': {
    post: operation(
      'storageAdminCleanupPreview',
      'Предпросмотр не более 1000 файлов без ссылок: previewId, count, bytes; действует 10 минут, привязан к администратору',
      [user],
    ),
  },
  '/api/v1/admin/storage/users/{userId}/cleanup': {
    post: operation(
      'storageAdminCleanup',
      'Поставить файлы предпросмотра в очередь удаления; повтор безопасен, ссылки проверяются ещё раз',
      [user],
      {
        type: 'object',
        required: ['previewId', 'confirmUserId'],
        properties: {
          previewId: { type: 'string', format: 'uuid' },
          confirmUserId: { type: 'string', description: 'Точное совпадение с userId в пути' },
        },
      },
    ),
  },
};
