import type { Environment } from '../shared/infrastructure/environment.js';

export function configureS3(environment: Environment) {
  if (environment.FILES_S3_ENABLED !== 'true') return undefined;
  const accessKeyId = environment.FILES_S3_ACCESS_KEY_ID;
  const secretAccessKey = environment.FILES_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey || secretAccessKey.length < 32)
    throw new Error(
      'Native S3 requires FILES_S3_ACCESS_KEY_ID and FILES_S3_SECRET_ACCESS_KEY (at least 32 characters)',
    );
  const port = Number(environment.FILES_S3_PORT ?? 3051);
  const maxObjectBytes = Number(environment.FILES_S3_MAX_OBJECT_BYTES ?? 10_000_000_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FILES_S3_PORT');
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1)
    throw new Error('Invalid FILES_S3_MAX_OBJECT_BYTES');
  const corsOrigins = (environment.FILES_S3_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('FILES_S3_CORS_ORIGINS must contain explicit HTTP origins');
  }
  return {
    directory: environment.FILES_S3_DIRECTORY ?? '/data/s3',
    port,
    maxObjectBytes,
    credentials: {
      accessKeyId,
      secretAccessKey,
      region: environment.FILES_S3_REGION ?? 'us-east-1',
      corsOrigins,
    },
  };
}
