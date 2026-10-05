import type { FileReferencesPort } from '../../application/ports/file-references.js';
import type { AuthMode } from '../../../access/contracts.js';
import type { StorageProvider } from '../../domain/file.js';
import type { StorageAdminService } from '../../application/storage-admin-service.js';
import type { DirectUploadService } from '../../application/direct-upload-service.js';
export interface FileHttpOptions {
  directUploads?: DirectUploadService;
  maxFileBytes?: (userId: string) => Promise<number>;
  storageAdminService?: StorageAdminService;
  authenticateStorageAdmin?: (header: string | undefined) => Promise<string>;
  storageProvider?: StorageProvider;
  genericFiles?: boolean;
  deleteEnabled?: boolean;
  authMode?: AuthMode;
  contentPrefix?: string;
  uiEnabled?: boolean;
  staticDirectory: URL;
  referenceRepository?: FileReferencesPort;
  authenticateReferences?: (header: string | undefined) => Promise<void>;
}
