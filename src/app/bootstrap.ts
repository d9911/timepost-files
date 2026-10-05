import { startLocalS3 } from './start-s3.js';
import { withRequestContext } from '../shared/infrastructure/request-context.js';
import { referenceAuthorization } from '../modules/access/infrastructure/reference-authorization.js';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import pg from 'pg';

import { configure } from './configuration.js';
import { processDelete } from '../modules/files/application/process-delete.js';
import { createHandler } from '../modules/files/presentation/http/file-handler.js';
import { PostgresFileRepository } from '../modules/files/infrastructure/persistence/postgres-file-repository.js';
import { createFileService } from './create-file-service.js';
import { PostgresStoragePolicies } from '../modules/files/infrastructure/persistence/postgres-storage-policies.js';
import { StorageAdminService } from '../modules/files/application/storage-admin-service.js';
import { storageAdminAuthorization } from '../modules/access/infrastructure/storage-admin-authorization.js';
import { DirectUploadService } from '../modules/files/application/direct-upload-service.js';
import { S3Storage } from '../modules/files/infrastructure/storage/s3-storage.js';
import { ValidatedMediaInspector } from '../modules/files/infrastructure/media/media-inspector.js';
import { CryptoFileIdentity } from '../modules/files/infrastructure/identity/crypto-file-identity.js';

export async function startApplication(): Promise<void> {
  if (process.env.FILES_ROLE === 's3') {
    if (process.env.FILES_S3_ENABLED !== 'true')
      throw new Error('FILES_ROLE=s3 requires FILES_S3_ENABLED=true');
    await startLocalS3();
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('Не задан DATABASE_URL');
  const { authorization, storage, options } = configure(process.env);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 8,
    connectionTimeoutMillis: 5000,
  });
  const repository = new PostgresFileRepository(
    pool,
    new URL('../../../migrations/', import.meta.url),
  );
  if (process.env.FILES_ROLE !== 'worker') await repository.initialize();
  const service = createFileService(repository, storage, authorization.authorizeProject, {
    genericFiles: options.genericFiles,
    deleteEnabled: options.deleteEnabled,
    requireManagedReferences: options.requireManagedReferences,
  });
  const policies = new PostgresStoragePolicies(pool);
  const directUploads =
    storage instanceof S3Storage &&
    storage.provider === 'yandex-object' &&
    process.env.S3_ACCESS_KEY_ID &&
    !process.env.YANDEX_IAM_TOKEN
      ? new DirectUploadService(
          repository,
          storage,
          authorization.authorizeProject,
          new ValidatedMediaInspector(),
          new CryptoFileIdentity(),
        )
      : undefined;
  let providerReady = false;
  try {
    await storage.ready();
    providerReady = true;
  } catch {
    console.error('Провайдер хранилища не готов; проверьте настройку доступа');
  }
  if (process.env.FILES_ROLE === 'worker') {
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        stopping = true;
      });
    let iteration = 0;
    while (!stopping) {
      try {
        // Не удаляем объекты, если настройки провайдера стали небезопасными.
        if (!providerReady || iteration % 60 === 0) {
          providerReady = false;
          await storage.ready();
          providerReady = true;
        }
        if (iteration++ % 60 === 0) {
          await repository.enqueueAbandoned(storage.provider);
          await policies.enqueueRetention(storage.provider);
        }
        await processDelete(repository, storage);
        await writeFile('/tmp/files-worker-ready', 'ok');
      } catch {
        console.error('Очередь удаления временно недоступна');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await pool.end();
  } else {
    await startLocalS3();
    const server = createServer(
      withRequestContext(
        createHandler(
          service,
          authorization.authenticate,
          async () => {
            await pool.query('SELECT 1');
            if (!providerReady) {
              await storage.ready();
              providerReady = true;
            }
          },
          {
            ...options,
            directUploads,
            maxFileBytes: async (userId) => (await policies.policy(userId)).maxFileBytes,
            storageAdminService: new StorageAdminService(
              new PostgresStoragePolicies(pool),
              storage.provider ?? 'yandex',
            ),
            authenticateStorageAdmin:
              options.authMode === 'timepost' ? storageAdminAuthorization(process.env) : undefined,
            referenceRepository: repository,
            authenticateReferences:
              options.authMode === 'timepost' ? referenceAuthorization(process.env) : undefined,
            storageProvider: storage.provider,
            staticDirectory: new URL('../../public/', import.meta.url),
          },
        ),
      ),
    );
    server.requestTimeout = 90000;
    server.headersTimeout = 15000;
    server.listen(Number(process.env.PORT ?? 3050), '0.0.0.0');
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () =>
        server.close(() => {
          void pool.end();
        }),
      );
  }
}
