export type StoragePlanId = 'start' | 'pro' | 'business';
export interface StoragePolicy {
  planId: StoragePlanId;
  maxFileBytes: number;
  quotaBytes: number | null;
  concurrentUploads: number;
  retentionDays: number;
  uploadsEnabled: boolean;
  retentionEnabled: boolean;
  version: number;
}
export interface StorageUserSettings {
  planId: StoragePlanId;
  maxFileBytes: number | null;
  quotaBytes: number | null;
  concurrentUploads: number | null;
  retentionDays: number | null;
  uploadsEnabled: boolean;
  retentionEnabled: boolean;
}
