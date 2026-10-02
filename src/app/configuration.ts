import { createApiKeyAuthorization } from '../modules/access/infrastructure/api-key-authorization.js';
import type { Authorization, AuthMode } from '../modules/access/application/authorization.js';
import type { Environment } from '../shared/infrastructure/environment.js';
import type { StorageProvider } from '../modules/files/domain/file.js';

import { createAuthorization } from '../modules/access/infrastructure/timepost-authorization.js';
import { LocalStorage } from '../modules/files/infrastructure/storage/local-storage.js';
import { YandexDiskStorage } from '../modules/files/infrastructure/storage/yandex-disk-storage.js';

export function configure(environment: Environment) {
  const authMode = environment.FILES_AUTH_MODE ?? 'timepost';
  const provider = environment.STORAGE_PROVIDER ?? 'yandex';
  if (!['yandex', 'simulator'].includes(provider)) throw new Error('Неизвестный STORAGE_PROVIDER');
  if (!['timepost', 'api-key'].includes(authMode)) throw new Error('Неизвестный FILES_AUTH_MODE');
  let authorization: Authorization;
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
    if ((environment.SYSTEM_JWT_SECRET ?? '').length < 32)
      throw new Error('Слишком короткий SYSTEM_JWT_SECRET');
    authorization = createAuthorization(environment);
  } else {
    authorization = createApiKeyAuthorization(environment);
  }
  const storage =
    provider === 'yandex'
      ? new YandexDiskStorage(environment.YANDEX_DISK_OAUTH_TOKEN)
      : new LocalStorage(environment.STORAGE_DIRECTORY ?? '/data/objects');
  return {
    authorization,
    storage,
    options: {
      authMode: authMode as AuthMode,
      provider: provider as StorageProvider,
      genericFiles: environment.FILES_GENERIC_ENABLED === 'true',
      deleteEnabled: authMode === 'api-key' && environment.FILES_DELETE_ENABLED === 'true',
      contentPrefix: environment.FILES_CONTENT_PREFIX ?? '/api/files-service',
      uiEnabled: environment.FILES_UI_ENABLED === 'true',
    },
  };
}
