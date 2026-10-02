import { mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

import { FileError } from './errors.mjs';

// Явный локальный симулятор: тот же интерфейс провайдера, без обращения к облаку.
export class LocalStorage {
  provider = 'simulator';
  constructor(directory) {
    this.directory = resolve(directory);
  }
  path(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new FileError(400, 'INVALID_FILE_ID', 'Неверный ID файла');
    return resolve(this.directory, id);
  }
  async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async upload(id, bytes) {
    await this.ready();
    const file = await open(this.path(id), 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async download(id) {
    const file = await open(this.path(id), 'r');
    return new Response(Readable.toWeb(file.createReadStream({ autoClose: true })));
  }
  async delete(id) {
    try {
      await unlink(this.path(id));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
