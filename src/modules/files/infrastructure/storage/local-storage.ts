import type { StoragePort } from '../../application/ports/object-storage.js';
import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

import { FileError } from '../../../../shared/application/file-error.js';

// Явный локальный симулятор: тот же интерфейс провайдера, без обращения к облаку.
export class LocalStorage implements StoragePort {
  readonly directory: string;
  readonly provider = 'simulator' as const;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  path(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new FileError('INVALID_FILE_ID', 'Неверный ID файла');
    return resolve(this.directory, id);
  }
  async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async upload(id: string, bytes: Uint8Array) {
    await this.ready();
    const file = await open(this.path(id), 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async download(id: string) {
    const file = await open(this.path(id), 'r');
    return file.createReadStream({ autoClose: true });
  }
  async delete(id: string) {
    try {
      await unlink(this.path(id));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
