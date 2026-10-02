export interface MediaMetadata {
  mimeType: string;
  width: number | null;
  height: number | null;
  durationSeconds?: number | null;
}
export interface MediaInspector {
  thumbnail?(bytes: Uint8Array): Promise<Uint8Array>;
  inspect(bytes: Uint8Array, mimeType: string): Promise<MediaMetadata>;
}
