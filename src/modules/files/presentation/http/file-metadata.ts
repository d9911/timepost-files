import type { FileMetadataDto } from './file-dto.js';
import type { FileRecord } from '../../domain/file.js';
export function publicMetadata(file: FileRecord, prefix = '/api/files-service'): FileMetadataDto {
  return {
    id: file.id,
    mediaFileId: file.id,
    projectId: file.projectId,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
    ...(file.durationSeconds != null ? { durationSeconds: file.durationSeconds } : {}),
    url: `${prefix}/api/v1/files/${file.id}/content`,
    ...(file.fileName ? { fileName: file.fileName } : {}),
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
    ...(file.provider ? { storageProvider: file.provider } : {}),
    ...(file.createdAt ? { createdAt: new Date(file.createdAt).toISOString() } : {}),
    ...(file.objectKey && file.bucket ? { directDownload: true } : {}),
  };
}
