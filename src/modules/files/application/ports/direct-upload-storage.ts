export interface DirectUploadStoragePort {
  readonly bucket: string;
  presignPut(
    key: string,
    mimeType: string,
    sizeBytes: number,
    metadata: Record<string, string>,
    expiresIn: number,
  ): Promise<string>;
  presignGet(key: string, fileName: string, expiresIn: number): Promise<string>;
  createMultipart(key: string, mimeType: string, metadata: Record<string, string>): Promise<string>;
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    sizeBytes: number,
    expiresIn: number,
  ): Promise<string>;
  listParts(
    key: string,
    uploadId: string,
  ): Promise<{ partNumber: number; sizeBytes: number; etag: string }[]>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  headObject(key: string): Promise<{
    sizeBytes: number;
    mimeType: string;
    etag: string;
    metadata: Record<string, string>;
  }>;
  downloadObject(key: string, etag?: string, range?: string): Promise<AsyncIterable<Uint8Array>>;
  promoteObject(
    sourceKey: string,
    targetKey: string,
    sizeBytes: number,
    etag: string,
  ): Promise<void>;
  deleteObject(key: string): Promise<void>;
}
