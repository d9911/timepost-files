export interface FileReferenceChange {
  projectId: string;
  referenceId: string;
  fileIds: string[];
  cleanupRemoved: boolean;
}
export interface FileReferencesPort {
  replaceReferences(change: FileReferenceChange): Promise<void>;
}
