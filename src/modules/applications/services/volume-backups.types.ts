import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { VolumeExportCapabilities } from '../../providers/interfaces/volume-export.interface';
import { BackupDestinationEntity } from '../../backups/entities/backup-destination.entity';
import { KopiaRetention } from '../../backups/utils/kopia-retention.util';

export interface BackupDestination {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional override; defaults to flui/<cluster>/<app>/<timestamp>/. */
  keyPrefix?: string;
}

/** A registered destination carries the passphrase its copies are encrypted with. */
export type ResolvedDestination = BackupDestination & {
  registered?: BackupDestinationEntity;
};

export interface CreateBackupForAppRequest {
  applicationId: string;
  /** Optional PVC name. If omitted and the app has exactly one PVC, that one is used. */
  volumeName?: string;
  /** Optional human-friendly suffix appended to the generated key prefix. */
  description?: string;
  /**
   * Explicit destination. When omitted the service auto-provisions a bucket
   * via the cluster provider's object-storage provisioner (Scaleway: full
   * auto, Hetzner: requires Object Storage credentials connected).
   */
  destination?: BackupDestination;
  /**
   * A registered backup destination to archive into. Preferred over passing
   * raw credentials: the copy is then linked to that destination in the ledger,
   * so it can be listed, previewed and restored like any other backup.
   */
  destinationId?: string;
  /**
   * Required when destination is auto-provisioned (the user owns the bucket
   * naming/billing scope).
   */
  userId?: string;
  /** Copy a volume that holds a live database anyway. */
  allowInconsistent?: boolean;
  /** Stop the writers, copy at rest, then start them again. */
  pause?: boolean;
  /** The policy that scheduled this copy, when one did. */
  policyId?: string;
  /** When retention says this copy stops being kept. */
  expiresAt?: Date;
  /** kopia: the policy's retention, applied to the repository on this run. */
  retention?: KopiaRetention;
  /** The policy run this copy belongs to. */
  backupJobId?: string;
  /** Why a policy's copy was taken; a copy without a policy is a manual one. */
  trigger?: 'scheduled' | 'pre-deploy';
  /** An operation opened when the copy was asked for, which this copy reports into. */
  operationId?: string;
}

export interface BackupResponse {
  exportId: string;
  appId: string;
  namespace: string;
  sourcePvcName: string;
  sizeGb: number;
  actualBytes?: number;
  createdAt: string;
  ready: boolean;
  destination: Omit<BackupDestination, 'accessKeyId' | 'secretAccessKey'>;
  provider: CloudProvider;
  providerCapabilities: VolumeExportCapabilities;
  /** Whether the copy reached the bucket through rclone crypt. */
  encrypted?: boolean;
  /** Set only when there is something true to say about this copy. */
  warning?: string;
  /** With a pause: seconds from stopping the application to it answering again. */
  interruptionSeconds?: number;
  /** With a pause: whether the application was ready again before Flui stopped waiting. */
  applicationBack?: boolean;
  /** `kopia` for a registered destination; `rclone` for a bucket passed by hand. */
  engine?: 'kopia' | 'rclone';
  /** kopia: the snapshot, and the ledger row that describes it. */
  snapshotId?: string;
  artifactId?: string;
  /** kopia: what this snapshot added to the repository. */
  uploadedBytes?: number;
}

/** What a queued backup answers with at once; the copy reports into the operation. */
export interface StartedBackup {
  operationId: string;
  applicationId: string;
  volumeName: string;
  status: 'pending';
}

/** A backup waiting in the queue. Raw bucket credentials travel sealed, never in the clear. */
export interface QueuedBackup {
  request: Omit<CreateBackupForAppRequest, 'destination'>;
  destinationSealed?: string;
}

export interface DeleteBackupForAppRequest {
  applicationId: string;
  exportId: string;
  destination: BackupDestination;
}
