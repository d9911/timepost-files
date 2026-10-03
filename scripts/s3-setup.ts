import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3Storage } from '../src/modules/files/infrastructure/storage/s3-storage.js';
// Создание бакета допускается только для явно выбранного локального стенда.
if (
  process.env.S3_ENDPOINT !== 'http://s3mock:9090' ||
  process.env.S3_ALLOW_INSECURE_LOCAL !== 'true'
)
  throw new Error('Разрешён только локальный S3Mock');
const storage = new S3Storage(process.env);
for (let attempt = 0; ; attempt += 1) {
  try {
    await storage.client.send(new CreateBucketCommand({ Bucket: storage.bucket }));
    break;
  } catch (error) {
    if (
      error instanceof Error &&
      ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)
    )
      break;
    if (attempt >= 29) throw new Error('Локальное S3 не готово');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await storage.ready();
storage.client.destroy();
console.log('Локальный S3-бакет готов');
