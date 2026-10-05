import type { StorageProvider } from '../../domain/file.js';

export interface FileMetadataDto {
  id: string;
  mediaFileId: string;
  projectId: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds?: number;
  url: string;
  fileName?: string;
  sha256?: string;
  storageProvider?: StorageProvider;
  createdAt?: string;
  directDownload?: boolean;
}

export interface FilesPageDto {
  items: FileMetadataDto[];
  nextCursor: string | null;
}
export interface StorageCapabilitiesDto {
  provider: StorageProvider;
  authMode: 'timepost' | 'api-key';
  maxBytes: number;
  maxVideoBytes: number;
  genericFiles: boolean;
  deleteEnabled: boolean;
  directUploads: boolean;
  maxFileBytes: number;
  multipartThreshold: number;
  partSize: number;
}
export interface ApiSuccess<T> {
  success: true;
  data: T;
}
export interface ApiFailure {
  success: false;
  error: { code: string; message: string };
}
