import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

/** A volume backup as the API lists it (`GET /applications/:id/volume-backups`). */
export interface VolumeBackup {
  id: string;
  volumeName: string | null;
  engine: 'kopia' | 'rclone' | 'pvc-clone' | 'unknown';
  createdAt: string | null;
  kept: 'retention' | 'until-deleted';
  logicalBytes: number | null;
  uploadedBytes: number | null;
  stored: 'present' | 'expired' | 'missing' | 'unknown';
  encrypted: boolean;
  restorable: boolean;
  browsable: boolean;
  reason: string | null;
  quiesce: string | null;
  snapshotId: string | null;
  destinationId: string | null;
}

export interface BackupFileEntry {
  name: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
  size: number | null;
  modifiedAt: string | null;
  mode: string | null;
  consistentCopy?: boolean;
}

export interface BackupListing {
  backupId: string;
  path: string;
  isFile: boolean;
  entries: BackupFileEntry[];
}

export interface VolumeRestoreResult {
  operationId: string;
  engine: 'kopia' | 'rclone';
  targetApplicationId: string;
  newPvcName: string;
  replaces: string | null;
}

export interface FilesRestoreResult {
  operationId: string;
  targetApplicationId: string;
  volumeName: string;
  paths: string[];
  targetDirectory: string | null;
}

/** A restore runs a Job on the cluster and answers when it is done. */
const RESTORE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export class VolumeBackupClient {
  constructor(private readonly api: ApiClient) {}

  static create(): VolumeBackupClient {
    const config = new ConfigStorage();
    return new VolumeBackupClient(
      new ApiClient({
        baseUrl: config.getApiUrlOrThrow(),
        apiKey: config.getApiKeyOrThrow(),
      }),
    );
  }

  list(appId: string): Promise<VolumeBackup[]> {
    return this.api.get<VolumeBackup[]>(
      `/applications/${encodeURIComponent(appId)}/volume-backups`,
    );
  }

  browse(
    appId: string,
    backupId: string,
    path?: string,
  ): Promise<BackupListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.api.get<BackupListing>(
      `/applications/${encodeURIComponent(appId)}/volume-backups/${encodeURIComponent(backupId)}/files${query}`,
      { timeoutMs: 5 * 60 * 1000 },
    );
  }

  restore(
    appId: string,
    backupId: string,
    body: { targetApplicationId?: string; volumeName?: string },
  ): Promise<VolumeRestoreResult> {
    return this.api.post<VolumeRestoreResult>(
      `/applications/${encodeURIComponent(appId)}/volume-backups/${encodeURIComponent(backupId)}/restore`,
      body,
      { timeoutMs: RESTORE_TIMEOUT_MS },
    );
  }

  restoreFiles(
    appId: string,
    backupId: string,
    body: {
      paths: string[];
      targetDirectory?: string;
      targetApplicationId?: string;
      volumeName?: string;
    },
  ): Promise<FilesRestoreResult> {
    return this.api.post<FilesRestoreResult>(
      `/applications/${encodeURIComponent(appId)}/volume-backups/${encodeURIComponent(backupId)}/restore-files`,
      body,
      { timeoutMs: RESTORE_TIMEOUT_MS },
    );
  }

  remove(appId: string, backupId: string): Promise<{ operationId: string }> {
    return this.api.delete<{ operationId: string }>(
      `/applications/${encodeURIComponent(appId)}/volume-backups/${encodeURIComponent(backupId)}`,
    );
  }
}

/** A backup named by its id, or by the first characters of it. */
export function resolveBackupId(
  backups: VolumeBackup[],
  ref: string,
): VolumeBackup {
  const exact = backups.find((b) => b.id === ref || b.snapshotId === ref);
  if (exact) return exact;
  const matches = backups.filter((b) => b.id.startsWith(ref));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `"${ref}" matches ${matches.length} backups; give more of the id`,
    );
  }
  throw new Error(`No volume backup "${ref}" (see \`flui app backup list\`)`);
}
