export function previewType(mimeType: string, fileName = '') {
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const inferred: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
  };
  const type = mimeType === 'application/octet-stream' ? inferred[extension] : mimeType;
  // HTML и SVG не открываются во встроенном просмотрщике.
  return type &&
    /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm)|audio\/(mpeg|wav|ogg|mp4|flac))$/.test(type)
    ? type
    : null;
}
export function suggestUniqueFileName(name: string, existing: Set<string>) {
  const used = new Set([...existing].map((value) => value.normalize('NFC').toLowerCase()));
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    const safeExtension = extension.slice(0, Math.max(0, 254 - suffix.length));
    const candidate =
      stem.slice(0, Math.max(0, 255 - suffix.length - safeExtension.length)) +
      suffix +
      safeExtension;
    if (!used.has(candidate.normalize('NFC').toLowerCase())) return candidate;
  }
}
