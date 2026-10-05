import sharp from 'sharp';
import { inspectUploadedStream } from './inspect-uploaded-stream.js';
import { FileError } from '../../../../shared/application/file-error.js';
import type { MediaInspector, MediaMetadata } from '../../application/ports/media-inspector.js';
import { inspectVideo, inspectVideoFile } from './inspect-video.js';

export class ValidatedMediaInspector implements MediaInspector {
  async inspectStream(stream: AsyncIterable<Uint8Array>, mimeType: string, sizeBytes: number) {
    return inspectUploadedStream(stream, sizeBytes, (path) => this.inspectFile(path, mimeType));
  }
  async thumbnailStream(stream: AsyncIterable<Uint8Array>, sizeBytes: number): Promise<Uint8Array> {
    const result = await inspectUploadedStream(stream, sizeBytes, async (path) => ({
      bytes: await sharp(path, { limitInputPixels: 4096 * 4096, failOn: 'warning' })
        .rotate()
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer(),
    }));
    return result.bytes;
  }
  async thumbnail(bytes: Uint8Array): Promise<Uint8Array> {
    return sharp(Buffer.from(bytes), { limitInputPixels: 4096 * 4096, failOn: 'warning' })
      .rotate()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  }
  async inspect(bytes: Uint8Array, mimeType: string): Promise<MediaMetadata> {
    if (mimeType.startsWith('video/'))
      return { mimeType, ...(await inspectVideo(bytes, mimeType)) };
    return this.inspectImage(Buffer.from(bytes));
  }
  async inspectFile(path: string, mimeType: string): Promise<MediaMetadata> {
    if (mimeType.startsWith('video/'))
      return { mimeType, ...(await inspectVideoFile(path, mimeType)) };
    return this.inspectImage(path);
  }
  private async inspectImage(input: string | Buffer): Promise<MediaMetadata> {
    const formats: Record<string, string> = {
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
    };
    try {
      const image = sharp(input, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
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
