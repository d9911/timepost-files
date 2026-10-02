import { createHash, randomUUID } from 'node:crypto';
import type { FileIdentity } from '../../application/ports/file-identity.js';

export class CryptoFileIdentity implements FileIdentity {
  createId(): string {
    return randomUUID();
  }
  checksum(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }
}
