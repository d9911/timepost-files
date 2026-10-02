import { FileService } from '../modules/files/application/file-service.js';
import type { FileRepositoryPort } from '../modules/files/application/ports/file-repository.js';
import type { StoragePort } from '../modules/files/application/ports/object-storage.js';
import type { AuthorizeProject } from '../modules/access/application/authorization.js';
import type { ServiceOptions } from '../modules/files/application/contracts.js';
import { ValidatedMediaInspector } from '../modules/files/infrastructure/media/media-inspector.js';
import { CryptoFileIdentity } from '../modules/files/infrastructure/identity/crypto-file-identity.js';

export function createFileService(
  repository: FileRepositoryPort,
  storage: StoragePort,
  authorizeProject: AuthorizeProject,
  options: ServiceOptions = {},
): FileService {
  return new FileService(
    repository,
    storage,
    authorizeProject,
    new ValidatedMediaInspector(),
    new CryptoFileIdentity(),
    options,
  );
}
