import type { DeleteRepositoryPort } from './ports/file-repository.js';
import type { StoragePort } from './ports/object-storage.js';
export async function processDelete(
  repository: DeleteRepositoryPort,
  storage: Pick<StoragePort, 'provider' | 'delete'>,
) {
  const job = await repository.claimDelete(storage.provider ?? 'yandex');
  if (!job) return false;
  try {
    await storage.delete(job.fileId);
    await repository.completeDelete(job);
  } catch {
    // Повтор переживает перезапуск процесса; ответ провайдера и секреты в БД не записываются.
    await repository.retryDelete(job);
  }
  return true;
}
