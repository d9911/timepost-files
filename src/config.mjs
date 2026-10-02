import { createHash, timingSafeEqual } from 'node:crypto';

import { createAuthorization } from './auth.mjs';
import { FileError } from './errors.mjs';
import { LocalStorage } from './local-storage.mjs';
import { YandexDiskStorage } from './yandex-disk.mjs';

export function configure(environment) {
  const authMode = environment.FILES_AUTH_MODE ?? 'timepost';
  const provider = environment.STORAGE_PROVIDER ?? 'yandex';
  if (!['yandex', 'simulator'].includes(provider)) throw new Error('Неизвестный STORAGE_PROVIDER');
  if (!['timepost', 'api-key'].includes(authMode)) throw new Error('Неизвестный FILES_AUTH_MODE');
  let authorization;
  if (authMode === 'timepost') {
    for (const name of [
      'ACCOUNTS_SERVICE_URL',
      'PROJECTS_SERVICE_URL',
      'SYSTEM_JWT_SECRET',
      'SYSTEM_JWT_ISSUER',
      'SYSTEM_JWT_AUDIENCE',
    ]) {
      if (!environment[name]) throw new Error(`Не задан ${name}`);
    }
    if (environment.SYSTEM_JWT_SECRET.length < 32)
      throw new Error('Слишком короткий SYSTEM_JWT_SECRET');
    authorization = createAuthorization(environment);
  } else {
    const key = environment.FILES_API_KEY;
    const readonly = environment.FILES_READONLY_API_KEY;
    if (!key || key.length < 32 || (readonly && (readonly.length < 32 || readonly === key)))
      throw new Error('Нужны разные ключи доступа длиной минимум 32 символа');
    const hash = (value) => createHash('sha256').update(value).digest();
    const ownerHash = hash(key),
      readerHash = readonly ? hash(readonly) : null;
    authorization = {
      async authenticate(header) {
        if (typeof header !== 'string' || !/^Bearer \S+$/.test(header))
          throw new FileError(401, 'UNAUTHORIZED', 'Нужен ключ доступа');
        const supplied = hash(header.slice(7));
        if (timingSafeEqual(supplied, ownerHash)) return '1';
        if (readerHash && timingSafeEqual(supplied, readerHash)) return '2';
        throw new FileError(401, 'UNAUTHORIZED', 'Неверный ключ доступа');
      },
      async authorizeProject(user, _project, write) {
        if (!['1', '2'].includes(user) || (write && user !== '1'))
          throw new FileError(403, 'PROJECT_FORBIDDEN', 'Ключ разрешает только чтение');
      },
    };
  }
  const storage =
    provider === 'yandex'
      ? new YandexDiskStorage(environment.YANDEX_DISK_OAUTH_TOKEN)
      : new LocalStorage(environment.STORAGE_DIRECTORY ?? '/data/objects');
  return {
    authorization,
    storage,
    options: {
      authMode,
      provider,
      genericFiles: environment.FILES_GENERIC_ENABLED === 'true',
      deleteEnabled: authMode === 'api-key' && environment.FILES_DELETE_ENABLED === 'true',
      contentPrefix: environment.FILES_CONTENT_PREFIX ?? '/api/files-service',
      uiEnabled: environment.FILES_UI_ENABLED === 'true',
    },
  };
}
