import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import pg from 'pg';

import { configure } from './configuration.js';
import { processDelete } from '../modules/files/application/process-delete.js';
import { createHandler } from '../modules/files/presentation/http/file-handler.js';
import { PostgresFileRepository } from '../modules/files/infrastructure/persistence/postgres-file-repository.js';
import { createFileService } from './create-file-service.js';

export async function startApplication(): Promise<void> {
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
  });
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
        if (iteration++ % 60 === 0) await repository.enqueueAbandoned(storage.provider);
        await processDelete(repository, storage);
        await writeFile('/tmp/files-worker-ready', 'ok');
      } catch {
        console.error('Очередь удаления временно недоступна');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await pool.end();
  } else {
    const server = createServer(
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
          storageProvider: storage.provider,
          staticDirectory: new URL('../../public/', import.meta.url),
        },
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
