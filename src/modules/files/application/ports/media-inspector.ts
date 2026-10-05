export interface MediaMetadata {
  mimeType: string;
  width: number | null;
  height: number | null;
  durationSeconds?: number | null;
}
export interface MediaInspector {
  inspectStream?(
    stream: AsyncIterable<Uint8Array>,
    mimeType: string,
    sizeBytes: number,
  ): Promise<MediaMetadata & { sha256: string }>;
  thumbnailStream?(stream: AsyncIterable<Uint8Array>, sizeBytes: number): Promise<Uint8Array>;
  thumbnail?(bytes: Uint8Array): Promise<Uint8Array>;
  inspectFile?(path: string, mimeType: string): Promise<MediaMetadata>;
  inspect(bytes: Uint8Array, mimeType: string): Promise<MediaMetadata>;
}
