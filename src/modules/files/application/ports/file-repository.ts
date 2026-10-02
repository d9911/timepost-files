import type {
  FileRecord,
  FileStatus,
  StorageProvider,
  DeleteJob,
  DeleteStatus,
} from '../../domain/file.js';
export interface FileRepositoryPort {
  insert(file: FileRecord): Promise<void>;
  setStatus(id: string, status: FileStatus): Promise<void>;
  get(id: string): Promise<FileRecord | undefined>;
  list(
    projectId: string,
    limit: number,
    cursor: string | null,
    provider: StorageProvider,
  ): Promise<FileRecord[]>;
  queueDelete(id: string): Promise<void>;
  deleteStatus(id: string): Promise<DeleteStatus | undefined>;
}
export interface DeleteRepositoryPort {
  claimDelete(provider: StorageProvider): Promise<DeleteJob | undefined>;
  completeDelete(job: DeleteJob): Promise<void>;
  retryDelete(job: DeleteJob): Promise<void>;
}
