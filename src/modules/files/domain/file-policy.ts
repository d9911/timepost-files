export const maxBytes = 10 * 1024 * 1024;
export const maxVideoBytes = 100 * 1024 * 1024;
export function uploadLimit(mimeType = 'application/octet-stream'): number {
  return ['video/mp4', 'video/webm'].includes(mimeType) ? maxVideoBytes : maxBytes;
}
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
