import { createServer } from 'node:http';
import { LocalObjectStore } from '../modules/s3/infrastructure/local-object-store.js';
import { createS3Handler } from '../modules/s3/presentation/s3-handler.js';
import { configureS3 } from './s3-configuration.js';

export async function startLocalS3(): Promise<void> {
  const options = configureS3(process.env);
  if (!options) return;
  const store = new LocalObjectStore(options.directory, options.maxObjectBytes);
  await store.initialize();
  const server = createServer(createS3Handler(store, options.credentials));
  server.requestTimeout = 20 * 60 * 1000;
  server.setTimeout(60_000, (socket) => socket.destroy());
  server.headersTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
