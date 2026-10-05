import type { FileRecord, FileStatus } from '../../domain/file.js';
import type { MediaMetadata } from './media-inspector.js';

export interface DirectUploadRepositoryPort {
  insert(file: FileRecord): Promise<void>;
  get(id: string): Promise<FileRecord | undefined>;
  setMultipart(id: string, uploadId: string): Promise<void>;
  completeUpload(
    id: string,
    ownerId: string,
    work: (file: FileRecord) => Promise<MediaMetadata & { sha256: string }>,
  ): Promise<FileRecord>;
  cancelUpload(id: string, ownerId: string): Promise<void | FileStatus>;
}
