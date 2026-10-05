export type StorageProvider = 'yandex' | 'simulator' | 's3' | 'selectel' | 'aws' | 'yandex-object';
export type FileStatus = 'pending' | 'ready' | 'deleting' | 'deleted';
export interface FileRecord {
  id: string;
  ownerId: string;
  projectId: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds?: number | null;
  fileName?: string | null;
  sha256?: string | null;
  provider?: StorageProvider;
  createdAt?: string | Date;
  status?: FileStatus;
  bucket?: string | null;
  objectKey?: string | null;
  incomingKey?: string | null;
  multipartUploadId?: string | null;
  uploadExpiresAt?: string | Date | null;
  socialNetwork?: string | null;
}
export interface DeleteJob {
  fileId: string;
  leaseId: string;
  attempts?: number;
  objectKey?: string | null;
  incomingKey?: string | null;
  multipartUploadId?: string | null;
  bucket?: string | null;
}
export interface DeleteStatus {
  fileId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
}
