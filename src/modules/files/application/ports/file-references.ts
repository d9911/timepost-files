import type { FileRecord } from '../../domain/file.js';
export interface FileReferenceChange {
  projectId: string;
  referenceId: string;
  fileIds: string[];
  cleanupRemoved: boolean;
}
export interface FileReferencesPort {
  replaceReferences(change: FileReferenceChange): Promise<void>;
  referencedFile?(
    projectId: string,
    referenceId: string,
    fileId: string,
  ): Promise<FileRecord | undefined>;
}
