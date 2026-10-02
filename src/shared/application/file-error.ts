import type { FileErrorCode } from './error-codes.js';

export class FileError extends Error {
  constructor(
    public readonly code: FileErrorCode,
    message: string,
  ) {
    super(message);
  }
}
