import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FileError } from '../../../../shared/application/file-error.js';
export async function inspectUploadedStream<T extends object>(
  stream: AsyncIterable<Uint8Array>,
  sizeBytes: number,
  inspect: (path: string) => Promise<T>,
): Promise<T & { sha256: string }> {
  const space = await statfs(tmpdir());
  if (space.bavail * space.bsize < sizeBytes)
    throw new FileError('STORAGE_UNAVAILABLE', 'Недостаточно временного места для проверки файла');
  const directory = await mkdtemp(join(tmpdir(), 'files-upload-'));
  const path = join(directory, 'original');
  try {
    const hash = createHash('sha256');
    let size = 0;
    const checked = async function* () {
      for await (const bytes of stream) {
        size += bytes.length;
        if (size > sizeBytes)
          throw new FileError('FILE_TOO_LARGE', 'Объект больше заявленного размера');
        hash.update(bytes);
        yield bytes;
      }
    };
    await pipeline(Readable.from(checked()), createWriteStream(path, { mode: 0o600 }), {
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    if (size !== sizeBytes) throw new FileError('STORAGE_INVALID_RESPONSE', 'Неполный объект');
    return { ...(await inspect(path)), sha256: hash.digest('hex') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
