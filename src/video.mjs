import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { FileError } from './errors.mjs';

const execute = promisify(execFile);

export async function inspectVideo(bytes, mimeType) {
  const directory = await mkdtemp(join(tmpdir(), 'files-video-'));
  const path = join(directory, 'input');
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    // Только локальный файл: плейлисты и внешние сетевые ссылки не разрешены.
    const { stdout } = await execute(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt',
        '-of',
        'json',
        path,
      ],
      { timeout: 15000, maxBuffer: 65536 },
    );
    const probe = JSON.parse(stdout);
    const streams = probe.streams ?? [];
    const video = streams.filter((stream) => stream.codec_type === 'video');
    const audio = streams.filter((stream) => stream.codec_type === 'audio');
    const mp4 = mimeType === 'video/mp4';
    const duration = Number(probe.format?.duration);
    if (
      video.length !== 1 ||
      audio.length > 1 ||
      streams.length !== video.length + audio.length ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 3600 ||
      !Number.isInteger(video[0].width) ||
      !Number.isInteger(video[0].height) ||
      video[0].width < 1 ||
      video[0].height < 1 ||
      video[0].width > 4096 ||
      video[0].height > 4096 ||
      (mp4
        ? !probe.format.format_name?.includes('mp4') ||
          video[0].codec_name !== 'h264' ||
          !['yuv420p', 'yuvj420p'].includes(video[0].pix_fmt) ||
          audio.some((stream) => stream.codec_name !== 'aac')
        : !probe.format.format_name?.includes('webm') ||
          !['vp8', 'vp9'].includes(video[0].codec_name) ||
          audio.some((stream) => !['opus', 'vorbis'].includes(stream.codec_name)))
    )
      throw new Error('format');
    return { width: video[0].width, height: video[0].height, durationSeconds: duration };
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new FileError(503, 'VIDEO_PROCESSOR_UNAVAILABLE', 'Не установлен ffprobe');
    throw new FileError(
      415,
      'INVALID_VIDEO',
      'Нужно MP4 H.264/AAC или WebM VP8/VP9 до 4096×4096 и 60 минут',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
