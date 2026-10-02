import sharp from 'sharp';
import { FileError } from '../../../../shared/application/file-error.js';
import type { MediaInspector, MediaMetadata } from '../../application/ports/media-inspector.js';
import { inspectVideo } from './inspect-video.js';

export class ValidatedMediaInspector implements MediaInspector {
  async inspect(bytes: Uint8Array, mimeType: string): Promise<MediaMetadata> {
    if (mimeType.startsWith('video/'))
      return { mimeType, ...(await inspectVideo(bytes, mimeType)) };
    const formats: Record<string, string> = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    try {
      const image = sharp(Buffer.from(bytes), { limitInputPixels: 4096 * 4096, failOn: 'warning' });
      const metadata = await image.metadata();
      const confirmedMime = formats[metadata.format ?? ''];
      if (
        !confirmedMime ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 4096 ||
        metadata.height > 4096 ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error('format');
      // Декодер проверяет содержимое; прикладной слой не зависит от sharp.
      await image.stats();
      return { mimeType: confirmedMime, width: metadata.width, height: metadata.height };
    } catch {
      throw new FileError('INVALID_IMAGE', 'Нужна фотография JPEG, PNG или WebP до 4096×4096');
    }
  }
}
