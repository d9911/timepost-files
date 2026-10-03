import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

export function configureLocalS3(source: string): string {
  const current = parseEnv(source);
  const endpoint = 'http://s3mock:9090';
  if (
    (current.S3_ENDPOINT && current.S3_ENDPOINT !== endpoint) ||
    (current.STORAGE_PROVIDER && !['simulator', 's3'].includes(current.STORAGE_PROVIDER))
  ) {
    throw new Error(
      'Настроен другой провайдер. make start-s3 не изменяет облачную конфигурацию; настройте .env явно.',
    );
  }
  const settings: Record<string, string> = {
    STORAGE_PROVIDER: 's3',
    S3_ENDPOINT: endpoint,
    S3_REGION: current.S3_REGION || 'us-east-1',
    S3_BUCKET: current.S3_BUCKET || 'timepost-files',
    S3_ACCESS_KEY_ID: current.S3_ACCESS_KEY_ID || randomBytes(12).toString('hex'),
    S3_SECRET_ACCESS_KEY: current.S3_SECRET_ACCESS_KEY || randomBytes(32).toString('hex'),
    S3_ALLOW_INSECURE_LOCAL: 'true',
  };
  // Сохраняем ключи Files, пароль БД, порт и все настройки вне локального адаптера S3.
  for (const [name, value] of Object.entries(settings)) {
    if (current[name] === value) continue;
    const pattern = new RegExp(`^${name}=.*$`, 'gm');
    source = pattern.test(source)
      ? source.replace(pattern, `${name}=${value}`)
      : `${source.trimEnd()}\n${name}=${value}\n`;
  }
  return source;
}
