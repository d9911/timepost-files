import { createPopup } from './popup.js';
import { previewType } from './media-helpers.js';
import { t } from './preferences.js';
import type { FileMetadataDto } from '../src/modules/files/presentation/http/file-dto.js';

export async function previewFile(
  file: FileMetadataDto,
  download: (signal: AbortSignal) => Promise<Blob>,
) {
  const popup = createPopup(file.fileName ?? file.id);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = t('previewLoading');
  popup.body.append(status);
  let url: string | undefined;
  let player: HTMLMediaElement | undefined;
  popup.onClose(() => {
    player?.pause();
    player?.removeAttribute('src');
    player?.load();
    if (url) URL.revokeObjectURL(url);
  });
  try {
    const mime = previewType(file.mimeType, file.fileName);
    if (!mime) {
      status.textContent = t('previewUnsupported');
      return;
    }
    const bytes = await download(popup.signal);
    if (popup.signal.aborted) return;
    url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    let media: HTMLImageElement | HTMLMediaElement;
    if (mime.startsWith('image/')) {
      media = document.createElement('img');
      media.alt = file.fileName ?? t('preview');
    } else {
      player = document.createElement(mime.startsWith('video/') ? 'video' : 'audio');
      player.controls = true;
      player.preload = 'metadata';
      if (player instanceof HTMLVideoElement) player.playsInline = true;
      media = player;
    }
    media.src = url;
    media.addEventListener('error', () => {
      status.textContent = t('previewFailed');
      popup.body.replaceChildren(status);
    });
    popup.body.replaceChildren(media);
  } catch (error) {
    if (!popup.signal.aborted)
      status.textContent = error instanceof Error ? error.message : t('previewFailed');
  }
}
