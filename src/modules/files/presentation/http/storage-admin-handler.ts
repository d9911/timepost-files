import type { IncomingMessage } from 'node:http';
import type { StorageAdminService } from '../../application/storage-admin-service.js';
import { FileError } from '../../../../shared/application/file-error.js';
async function body(request: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 16384)
      throw new FileError('FILE_TOO_LARGE', 'Тело настроек слишком большое');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FileError('INVALID_FILE_ID', 'Неверный JSON');
  }
}
export async function storageAdminRoute(
  request: IncomingMessage,
  url: URL,
  actor: string,
  service: StorageAdminService,
): Promise<unknown> {
  const repo = service.repository;
  const path = url.pathname.replace('/api/v1/admin/storage', '');
  if (request.method === 'GET' && path === '/summary') return repo.summary(service.provider);
  if (request.method === 'GET' && path === '/plans') return repo.plans();
  if (request.method === 'GET' && path === '/users') {
    const userId = url.searchParams.get('userId') ?? '';
    const cursor = url.searchParams.get('cursor') ?? '';
    if ((userId && !/^\d+$/.test(userId)) || (cursor && !/^\d+$/.test(cursor)))
      throw new FileError('INVALID_PAGINATION', 'Неверный ID');
    return repo.users(service.provider, cursor, userId);
  }
  const match = /^\/users\/(\d+)(?:\/(cleanup-preview|cleanup))?$/.exec(path);
  if (match) {
    const userId = match[1]!;
    if (request.method === 'GET' && !match[2])
      return { settings: await repo.settings(userId), effective: await repo.policy(userId) };
    if (request.method === 'PUT' && !match[2])
      return service.update(actor, userId, await body(request));
    if (request.method === 'POST' && match[2] === 'cleanup-preview')
      return repo.cleanupPreview(actor, userId, service.provider);
    if (request.method === 'POST' && match[2] === 'cleanup') {
      const value = (await body(request)) as { previewId?: unknown; confirmUserId?: unknown };
      if (
        value?.confirmUserId !== userId ||
        typeof value?.previewId !== 'string' ||
        !/^[-0-9a-f]{36}$/.test(value.previewId)
      )
        throw new FileError('INVALID_FILE_ID', 'Подтвердите ID пользователя');
      return repo.cleanup(actor, userId, value.previewId);
    }
  }
  const plan = /^\/plans\/(start|pro|business)$/.exec(path);
  if (request.method === 'PUT' && plan)
    return service.updatePlan(actor, plan[1]!, await body(request));
  throw new FileError('NOT_FOUND', 'Маршрут не найден');
}
