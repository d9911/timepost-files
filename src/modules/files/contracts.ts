// Публичные типы модуля: адаптерам не требуется импортировать классы реализации.
export type {
  FileRecord,
  FileStatus,
  StorageProvider,
  DeleteJob,
  DeleteStatus,
} from './domain/file.js';
export type {
  FileRepositoryPort,
  DeleteRepositoryPort,
} from './application/ports/file-repository.js';
export type { StoragePort } from './application/ports/object-storage.js';
export type { MediaInspector, MediaMetadata } from './application/ports/media-inspector.js';
export type { FileIdentity } from './application/ports/file-identity.js';
export type { ServiceOptions } from './application/contracts.js';
