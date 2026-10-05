import type { StoragePolicy, StorageUserSettings } from '../../domain/storage-policy.js';
export interface StoragePoliciesPort {
  policy(userId: string): Promise<StoragePolicy>;
  plans(): Promise<StoragePolicy[]>;
  updatePlan(actorId: string, id: string, policy: StoragePolicy): Promise<void>;
  settings(userId: string): Promise<StorageUserSettings>;
  updateUser(actorId: string, userId: string, settings: StorageUserSettings): Promise<void>;
  enqueueRetention(provider: string): Promise<number>;
  summary(provider: string): Promise<unknown>;
  users(provider: string, cursor: string, userId: string): Promise<unknown>;
  cleanupPreview(actorId: string, userId: string, provider: string): Promise<unknown>;
  cleanup(actorId: string, userId: string, previewId: string): Promise<unknown>;
}
