import type { AuthMode } from '../../../access/contracts.js';
import type { StorageProvider } from '../../domain/file.js';
export interface FileHttpOptions {
  storageProvider?: StorageProvider;
  genericFiles?: boolean;
  deleteEnabled?: boolean;
  authMode?: AuthMode;
  contentPrefix?: string;
  uiEnabled?: boolean;
  staticDirectory: URL;
}
