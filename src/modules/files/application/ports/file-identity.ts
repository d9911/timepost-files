export interface FileIdentity {
  createId(): string;
  checksum(bytes: Uint8Array): string;
}
