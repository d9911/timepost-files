import type { StoragePoliciesPort } from './ports/storage-policies.js';
import type { StoragePolicy, StorageUserSettings } from '../domain/storage-policy.js';
import { FileError } from '../../../shared/application/file-error.js';
export function parseStorageSettings(value: unknown, plan = false): StorageUserSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new FileError('INVALID_FILE_ID', 'Неверные настройки');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        ![
          'planId',
          'maxFileBytes',
          'quotaBytes',
          'concurrentUploads',
          'retentionDays',
          'uploadsEnabled',
          'retentionEnabled',
        ].includes(key),
    )
  )
    throw new FileError('INVALID_FILE_ID', 'Неизвестное поле настроек');
  if (
    !['start', 'pro', 'business'].includes(String(v.planId)) ||
    typeof v.uploadsEnabled !== 'boolean' ||
    v.retentionEnabled !== false
  )
    throw new FileError('INVALID_FILE_ID', 'Автоудаление пока отключено; укажите профиль хранения');
  for (const [key, max] of [
    ['maxFileBytes', 10000000000],
    ['quotaBytes', Number.MAX_SAFE_INTEGER],
    ['concurrentUploads', 32],
    ['retentionDays', 3650],
  ] as const) {
    const n = v[key];
    if (n === null && (!plan || key === 'quotaBytes')) continue;
    if (
      typeof n !== 'number' ||
      !Number.isSafeInteger(n) ||
      n < (key === 'quotaBytes' ? 0 : 1) ||
      n > max
    )
      throw new FileError('INVALID_FILE_ID', `Неверное значение ${key}`);
  }
  return v as unknown as StorageUserSettings;
}
export class StorageAdminService {
  constructor(
    readonly repository: StoragePoliciesPort,
    readonly provider: string,
  ) {}
  async update(actor: string, userId: string, value: unknown) {
    if (!/^\d+$/.test(userId)) throw new FileError('INVALID_FILE_ID', 'Неверный пользователь');
    await this.repository.updateUser(actor, userId, parseStorageSettings(value));
    return {
      settings: await this.repository.settings(userId),
      effective: await this.repository.policy(userId),
    };
  }
  async updatePlan(actor: string, id: string, value: unknown) {
    const settings = parseStorageSettings(value, true);
    if (settings.planId !== id) throw new FileError('INVALID_FILE_ID', 'Профиль не совпадает');
    await this.repository.updatePlan(actor, id, { ...settings, version: 0 } as StoragePolicy);
    return this.repository.plans();
  }
}
