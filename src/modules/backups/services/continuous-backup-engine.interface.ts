import { BackupDestinationEntity } from '../entities/backup-destination.entity';

/**
 * What a restore needs to know about an artifact when everything else is gone.
 *
 * Written onto the artifact at backup time, never re-derived. A disaster
 * restore runs when the application, its manifest and possibly its cluster no
 * longer exist, so anything the restore has to look up somewhere else is
 * something it may not find.
 */
export interface ArtifactEngineFacts {
  engine: string;
  /**
   * The database server's own version, read from the running server.
   *
   * The restore installs a catalog slug at whatever tag the seed carries at
   * that moment. A data directory does not open under a different major, so
   * without this the mismatch is discovered mid-recovery.
   */
  engineVersion?: string;
  /** The tool that wrote it, and its version. */
  tool: string;
  toolVersion?: string;
  /** Catalog slug and image tag the source ran on. */
  catalogSlug: string;
  imageTag?: string;
  /** The bootstrap identities the restored instance has to be given. */
  identities: Record<string, string>;
  /** Engine position the base backup ends at, when the engine has one. */
  position?: Record<string, string>;
}

/**
 * One continuous-backup engine.
 *
 * The class is a real thing — one application, one off-provider destination,
 * delete stops the shipping, retention counted in full backups — and all of
 * that stays true of a second engine. What differs is the tool, and only the
 * tool belongs behind this.
 *
 * Implementations must hold no engine credential: every command runs inside
 * the workload's own container, using the environment that container already
 * has. Flui supplies object-storage credentials and nothing else.
 */
export interface ContinuousBackupEngine {
  /** Matches the catalog's declared `engine:`. */
  readonly engine: string;

  /** The catalog slug a restore of this engine installs. */
  readonly catalogSlug: string;

  /** Prefix for the environment a restored instance is booted with. */
  readonly restoreEnvPrefix: string;

  /**
   * Refuse before touching anything if this instance cannot do continuous
   * backup — a missing binary, a server option that needs a restart, a
   * database that is not running. The message must say which, because "it
   * failed" sends people to the wrong fix.
   */
  requireTooling(appId: string): Promise<void>;

  /** Configure shipping and prove it works, before any policy row exists. */
  enable(
    appId: string,
    destination: BackupDestinationEntity,
    opts?: { retentionFull?: number },
  ): Promise<void>;

  /**
   * Stop shipping and restore the engine's own defaults.
   *
   * Not optional cleanup: a database left shipping to a repository nothing
   * manages either retains its logs until the volume fills, or purges them on
   * a timer that knows nothing about what was saved. Both are failures of the
   * source, caused by a backup that was deleted.
   */
  disable(appId: string): Promise<void>;

  /** Take a base backup and return its engine-side reference. */
  baseBackup(appId: string, type?: 'full' | 'incr' | 'diff'): Promise<string>;

  /** The recoverable window, read from what actually reached the repository. */
  info(appId: string): Promise<{
    latestLabel: string | null;
    oldestRecoverable: string | null;
    newestRecoverable: string | null;
  }>;

  /** Everything the artifact must carry for a restore years from now. */
  describeForArtifact(appId: string): Promise<ArtifactEngineFacts>;

  /**
   * Environment a restored instance is booted with.
   *
   * `restoreSet` names a specific base backup when the caller has resolved one;
   * omitted, the engine replays to `recoveryTargetTime` instead. The two are
   * alternatives, which is why neither is required.
   */
  buildRestoreEnv(
    sourceAppId: string,
    destination: BackupDestinationEntity,
    recoveryTargetTime?: Date,
    restoreSet?: string,
  ): Record<string, string>;
}
