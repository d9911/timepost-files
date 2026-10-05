import type { DeleteRepositoryPort } from './ports/file-repository.js';
import type { StoragePort } from './ports/object-storage.js';
import type { DirectUploadStoragePort } from './ports/direct-upload-storage.js';
export async function processDelete(
  repository: DeleteRepositoryPort,
  storage: Pick<StoragePort, 'provider' | 'delete'>,
) {
  const job = await repository.claimDelete(storage.provider ?? 'yandex');
  if (!job) return false;
  try {
    if (job.incomingKey && 'abortMultipart' in storage && 'deleteObject' in storage) {
      const direct = storage as Pick<StoragePort, 'provider' | 'delete'> & DirectUploadStoragePort;
      if (job.bucket && job.bucket !== direct.bucket) throw new Error('Объект другого бакета');
      if (job.multipartUploadId) {
        try {
          await direct.abortMultipart(job.incomingKey, job.multipartUploadId);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'NoSuchUpload') throw error;
        }
      }
      await direct.deleteObject(job.incomingKey);
    }
    await storage.delete(job.fileId, job.objectKey ?? undefined);
    await repository.completeDelete(job);
  } catch {
    // Повтор переживает перезапуск процесса; ответ провайдера и секреты в БД не записываются.
    await repository.retryDelete(job);
  }
  return true;
}
