export interface MediaMetadata {
  mimeType: string;
  width: number | null;
  height: number | null;
  durationSeconds?: number | null;
}
export interface MediaInspector {
  inspect(bytes: Uint8Array, mimeType: string): Promise<MediaMetadata>;
}
