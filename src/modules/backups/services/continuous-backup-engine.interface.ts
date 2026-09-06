import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { RestoreStrategy } from '../enums/restore-job.enum';

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
  /**
   * The bootstrap identities the restored instance has to be given.
   *
   * Engine-neutral keys (`user`, `database`) rather than each tool's own
   * spelling, because the restore reads them without knowing which engine
   * wrote them — and because a restored instance boots as the SOURCE's role
   * and database, which exist in the recovered data, whatever the engine.
   */
  identities: { user: string; database: string };
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

  /**
   * Does this engine's tool expire its own repository?
   *
   * pgBackRest does, by `repo1-retention-full`, and deleting its objects from
   * outside corrupts a chain Flui does not own — so for it, retention drops
   * the stale row and leaves the data alone. An engine that answers `false`
   * has no such tool, and a sweeper that treated it the same way would delete
   * the record of a backup while leaving the backup itself in object storage,
   * paid for and pointed at by nothing.
   */
  readonly selfPrunesRepository: boolean;

  /** Prefix for the environment a restored instance is booted with. */
  readonly restoreEnvPrefix: string;

  /**
   * What the restore row says was done, in the record a person reads later.
   *
   * Per engine rather than one value for the whole class: `pg_pitr` on a
   * MariaDB recovery would be a false entry in the only place that says how
   * the data came back.
   */
  readonly restoreStrategy: RestoreStrategy;

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
    opts?: { retentionFull?: number; generation?: string },
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

  /**
   * Which kind of base backup to take right now.
   *
   * Optional because it is only a question for engines that have more than one
   * answer. Omitting it means every backup is a full — which is the truth for
   * MariaDB, not a simplification — and keeps the retention arithmetic that
   * counts fulls out of engines that have no chain to reason about.
   */
  chooseBackupType?(
    appId: string,
    fullEveryDays: number,
  ): Promise<'full' | 'incr' | 'diff'>;

  /**
   * Where this engine's objects live, relative to the destination's own
   * `pathPrefix`.
   *
   * Relative because `getUsage()` and `listObjects()` re-prepend the prefix; a
   * location row that repeated it would point one level too deep and report a
   * backup as missing.
   *
   * `generation` separates one life of a data directory from the next. An
   * engine whose log names restart from the beginning on a fresh volume — as
   * MariaDB's binary logs do — would otherwise write file names the repository
   * already holds from the previous life, with different contents behind them.
   * Engines whose names are unique across lifetimes ignore it.
   */
  artifactObjectPrefix(appId: string, generation?: string): string;

  /**
   * The object keys one artifact owns, in the order they must be deleted.
   *
   * Only for engines that do not expire their own repository; the others must
   * not have their objects touched from outside. Returned as keys rather than
   * deleted here so the engine owns the layout and the caller owns the
   * deleting — with its rules about what may be deleted unattended.
   *
   * Order is part of the contract, and it is the reverse of the upload. A base
   * becomes visible to readers when its position file lands, so removing that
   * file first takes the whole base out of view in one operation; the other
   * order leaves, on any interruption, a base every reader still believes in
   * and no reader can fetch.
   */
  artifactObjectKeys?(
    appId: string,
    engineRef: string,
    generation?: string,
  ): string[];

  /**
   * A fresh repository generation, when this engine needs one.
   *
   * Called once when protection is turned on, and again whenever the data
   * directory being protected is a new one — a restore, a lost volume, a
   * rebuild onto another cluster. Engines that cannot collide with their own
   * past return `undefined` and keep a flat layout.
   */
  mintGeneration?(): string;

  /**
   * Resolves once the database can be written to, not merely connected to.
   *
   * Readiness is `pg_isready`, which answers while the server is still
   * replaying WAL in hot standby — and `stanza-create` needs a primary. An
   * engine whose restore finishes before the container is Ready has nothing to
   * wait for and may leave this out.
   */
  awaitWritable?(appId: string): Promise<void>;

  /** The recoverable window, read from what actually reached the repository. */
  info(appId: string): Promise<{
    latestLabel: string | null;
    oldestRecoverable: string | null;
    newestRecoverable: string | null;
    /** Base backups the repository holds — zero means nothing to replay onto. */
    backupCount: number;
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
    /** The repository generation the artifact was written into. */
    generation?: string,
  ): Record<string, string>;

  /**
   * The source's own role and database, spelled the way this engine's image
   * expects to receive them.
   *
   * A restored instance must boot as the identities that exist in the
   * recovered data. MariaDB's entrypoint exits with `Unknown database` when
   * told to open one the restore did not contain, so this is not a nicety.
   */
  identityEnv(identities: {
    user: string;
    database: string;
  }): Record<string, string>;

  /**
   * Put the restored instance's own credentials back, once it is up.
   *
   * Optional because not every engine can wait until then. A recovered data
   * directory carries the SOURCE's accounts, so the generated password of the
   * new install does not open it; Postgres can fix that afterwards over a
   * local socket that needs no password, while MariaDB has no equivalent and
   * does it during the restore itself, before the server ever accepts a
   * connection.
   */
  reconcileAfterRestore?(newAppId: string): Promise<void>;
}
