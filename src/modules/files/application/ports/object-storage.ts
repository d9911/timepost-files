import type { StorageProvider } from '../../domain/file.js';
export interface StoragePort {
  readonly provider?: StorageProvider;
  ready(): Promise<void>;
  upload(id: string, bytes: Uint8Array, mimeType?: string): Promise<void>;
  download(id: string): Promise<AsyncIterable<Uint8Array>>;
  delete(id: string): Promise<void>;
}
