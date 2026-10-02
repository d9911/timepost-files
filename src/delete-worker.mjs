export async function processDelete(repository, storage) {
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
