import { createHash, timingSafeEqual } from 'node:crypto';
import type { Authorization } from '../application/authorization.js';
import type { Environment } from '../../../shared/infrastructure/environment.js';
import { FileError } from '../../../shared/application/file-error.js';
export function createApiKeyAuthorization(environment: Environment): Authorization {
  const key = environment.FILES_API_KEY;
  const readonly = environment.FILES_READONLY_API_KEY;
  if (!key || key.length < 32 || (readonly && (readonly.length < 32 || readonly === key)))
    throw new Error('Нужны разные ключи доступа длиной минимум 32 символа');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const ownerHash = hash(key),
    readerHash = readonly ? hash(readonly) : null;
  return {
    async authenticate(header) {
      if (typeof header !== 'string' || !/^Bearer \S+$/.test(header))
        throw new FileError('UNAUTHORIZED', 'Нужен ключ доступа');
      const supplied = hash(header.slice(7));
      if (timingSafeEqual(supplied, ownerHash)) return '1';
      if (readerHash && timingSafeEqual(supplied, readerHash)) return '2';
      throw new FileError('UNAUTHORIZED', 'Неверный ключ доступа');
    },
    async authorizeProject(user, _project, write) {
      if (!['1', '2'].includes(user) || (write && user !== '1'))
        throw new FileError('PROJECT_FORBIDDEN', 'Ключ разрешает только чтение');
    },
  };
}
