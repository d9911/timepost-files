import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

try {
  await writeFile(
    new URL('../../.env.native-s3', import.meta.url),
    [
      '# Independent local S3 credentials. Never commit this file.',
      'FILES_S3_ENABLED=true',
      'FILES_S3_HOST_PORT=3062',
      'FILES_S3_REGION=us-east-1',
      `FILES_S3_ACCESS_KEY_ID=${randomBytes(12).toString('hex')}`,
      `FILES_S3_SECRET_ACCESS_KEY=${randomBytes(32).toString('hex')}`,
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created files/.env.native-s3; credentials are not printed.');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  console.log('Existing files/.env.native-s3 preserved.');
}
