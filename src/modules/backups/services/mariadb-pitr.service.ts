import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  ArtifactEngineFacts,
  RestorePointMark,
  BaseNotDue,
  ContinuousBackupEngine,
  EngineEnableOptions,
} from './continuous-backup-engine.interface';
import {
  SHIPPER_ZSTD_FEATURE,
  parseShipperCompression,
} from './db-compression.util';
import { RestoreStrategy } from '../enums/restore-job.enum';
import { parseRestorePoint } from '../utils/restore-point.util';
import {
  MariadbTarget,
  SHIPPER_CRYPT_FEATURE,
  SHIPPER_SECRET_SUFFIX,
  artifactObjectKeys,
  artifactObjectPrefix,
  buildRestoreEnv,
  identityEnv,
  mintGeneration,
  renderShipperConfig,
} from './mariadb-pitr.util';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupDestinationsService } from './backup-destinations.service';
import { PlaintextRetirementService } from './plaintext-retirement.service';
import {
  CryptPasswords,
  RCLONE_CRYPT_CIPHER,
  deriveCryptPasswords,
  isCryptSummary,
  restorePasswords,
} from '../utils/rclone-crypt.util';
import {
  awaitShipperConfig,
  execInDatabase,
  execInShipper,
  listRepository,
  mariadbClient,
  mariadbTargetFor,
  queryDatabase,
  shippedEdgeCurrent,
  shipperConfigCurrent,
  shipperFeatures,
  shipperPresent,
} from './mariadb-pitr-exec.util';
import {
  BASE_INCOMPLETE,
  DATABASE_NOT_RUNNING,
  LOG_BIN_OFF,
  NO_SHIPPER_FOR_POLICY,
  ShippingState,
  TOOLING_SCRIPT,
  baseBackupScript,
  baseLabel,
  markRestorePointScript,
  missingToolMessage,
  nextBaseDue,
  prepareServerScript,
  releaseServerScript,
  repositoryWindow,
  shipperSecretManifest,
  utcIso,
} from './mariadb-pitr-scripts.util';

/**
 * Continuous backup for MariaDB: a base backup plus its binary logs.
 *
 * It differs from Postgres in one way that shapes everything here: MariaDB has
 * no `archive_command`. Postgres hands each finished segment to a command of
 * Flui's choosing, so shipping is the database's own job. MariaDB writes its
 * binary logs and forgets about them, so something has to be alive and reading
 * continuously — which is why this engine needs a companion process where
 * pgBackRest needed only a config file.
 *
 * Credentials follow the rule established with the Redis hook: every command
 * runs inside the workload's own container and authenticates from the
 * environment that container already has. Flui supplies object-storage
 * credentials and never an engine password.
 */
@Injectable()
export class MariadbPitrService implements ContinuousBackupEngine {
  private readonly logger = new Logger(MariadbPitrService.name);

  readonly engine = 'mariadb';
  readonly catalogSlug = 'mariadb';
  readonly restoreEnvPrefix = 'FLUI_MARIADB_';
  readonly restoreStrategy = RestoreStrategy.MARIADB_PITR;
  readonly selfPrunesRepository = false;
  readonly replaysToEndWithoutTarget = false;
  private readonly shipping = new Map<string, ShippingState>();

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly destinations: BackupDestinationsService,
    private readonly retirement: PlaintextRetirementService,
  ) {}

  async resolveTarget(appId: string): Promise<MariadbTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    }
    return mariadbTargetFor(
      app,
      this.encryption.decrypt(cluster.kubeconfigEncrypted),
    );
  }

  /**
   * Refuse before touching anything, and say which thing is wrong.
   *
   * The four failures need four different fixes and one message would send
   * people to the wrong one: a stopped database is started, a missing binary
   * means the wrong image, an absent shipper means the pod predates it, and
   * `log_bin = OFF` means a restart — which is why the catalog seed turns it
   * on at birth, so that branch is reached only by instances that predate it.
   *
   * The shipper is checked first among the pod-shaped failures. Its absence is
   * not fixed by starting the database, so reporting a stopped pod would send
   * someone to an action that changes nothing.
   */
  async requireTooling(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);

    if ((await shipperPresent(this.k8s, target)) === false) {
      throw new BadRequestException(NO_SHIPPER_FOR_POLICY);
    }

    let tools: string;
    try {
      tools = await execInDatabase(this.k8s, target, TOOLING_SCRIPT);
    } catch (err: any) {
      if (/No running pod/i.test(err?.message ?? '')) {
        throw new BadRequestException(DATABASE_NOT_RUNNING);
      }
      throw err;
    }
    const missing = missingToolMessage(tools);
    if (missing) throw new BadRequestException(missing);

    const logBin = await queryDatabase(this.k8s, target, 'SELECT @@log_bin');
    if (logBin !== '1') throw new BadRequestException(LOG_BIN_OFF);
  }

  /**
   * Make the server ready to be backed up, and prove it before anything is
   * recorded. The settings and why each is needed: {@link prepareServerScript}.
   */
  async enable(
    appId: string,
    destination: BackupDestinationEntity,
    opts?: EngineEnableOptions,
  ): Promise<void> {
    await this.requireTooling(appId);
    const target = await this.resolveTarget(appId);
    const features = await shipperFeatures(this.k8s, target);
    const crypt = features.has(SHIPPER_CRYPT_FEATURE)
      ? deriveCryptPasswords(await this.destinations.passphraseFor(destination))
      : undefined;
    const compressed = features.has(SHIPPER_ZSTD_FEATURE);
    if (!crypt) {
      this.logger.warn(
        `[mariadb-pitr] the shipper of app=${appId} predates encryption: its backups stay unencrypted until the shipper image is updated`,
      );
    }
    await this.writeShipperConfig(
      appId,
      target,
      destination,
      opts?.generation,
      crypt,
      compressed,
    );
    this.shipping.set(appId, {
      destinationId: destination.id,
      generation: opts?.generation,
      encrypted: !!crypt,
      compressed,
    });
    await execInDatabase(
      this.k8s,
      target,
      prepareServerScript(mariadbClient(target)),
    );
    this.logger.log(
      `[mariadb-pitr] prepared app=${appId} for continuous backup`,
    );
  }

  /**
   * Hand the server back its own defaults.
   *
   * Not optional cleanup. Leaving `binlog_expire_logs_seconds = 0` behind means
   * a database that never purges its binary logs again, and the volume fills —
   * an outage of the source, caused by a backup that was deleted.
   */
  async disable(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    // The destination goes first. Handing the server back its own expiry while
    // a shipper is still pointed at a repository nothing manages would let it
    // purge logs that are still being collected for a policy that no longer
    // exists.
    await this.k8s
      .deleteResource(
        target.kubeconfig,
        'Secret',
        `${target.container}${SHIPPER_SECRET_SUFFIX}`,
        target.namespace,
      )
      .catch((err: any) =>
        this.logger.warn(
          `[mariadb-pitr] could not remove the shipper destination for app=${appId}: ${err?.message}`,
        ),
      );
    await execInDatabase(
      this.k8s,
      target,
      releaseServerScript(mariadbClient(target)),
    );
    this.logger.log(`[mariadb-pitr] released app=${appId}`);
  }

  /** Hands the shipper its destination: {@link shipperSecretManifest}. */
  private async writeShipperConfig(
    appId: string,
    target: MariadbTarget,
    dest: BackupDestinationEntity,
    generation?: string,
    crypt?: CryptPasswords,
    compressed = false,
  ): Promise<void> {
    const config = renderShipperConfig({
      appId,
      dest,
      repositoryPrefix: this.artifactObjectPrefix(appId, generation),
      accessKey: this.encryption.decrypt(dest.accessKeyEncrypted),
      secretKey: this.encryption.decrypt(dest.secretKeyEncrypted),
      crypt,
      ...(compressed ? { compression: 'zstd' as const } : {}),
    });

    await this.k8s.applyManifest(
      target.kubeconfig,
      shipperSecretManifest({
        name: `${target.container}${SHIPPER_SECRET_SUFFIX}`,
        namespace: target.namespace,
        appId,
        config,
      }),
    );
    this.logger.log(
      `[mariadb-pitr] destination handed to the shipper for app=${appId}; ` +
        'it is picked up on the next kubelet sync, typically within a minute',
    );
  }

  async describeForArtifact(appId: string): Promise<ArtifactEngineFacts> {
    const target = await this.resolveTarget(appId);
    return {
      engine: this.engine,
      engineVersion: await queryDatabase(this.k8s, target, 'SELECT VERSION()'),
      tool: 'mariadb-backup',
      toolVersion: (
        await execInDatabase(
          this.k8s,
          target,
          'mariadb-backup --version 2>&1 | head -1',
        ).catch(() => '')
      )
        .trim()
        .slice(0, 32),
      catalogSlug: this.catalogSlug,
      identities: { user: target.user, database: target.database },
      position: {
        gtid:
          (await queryDatabase(this.k8s, target, 'SELECT @@gtid_binlog_pos')) ??
          '',
      },
      ...this.repositoryFacts(appId),
      ...(this.shipping.get(appId)?.lastBaseCompression
        ? { compression: this.shipping.get(appId)!.lastBaseCompression }
        : {}),
    };
  }

  /** Only what the base just taken reported, never what was intended. */
  private repositoryFacts(
    appId: string,
  ): Pick<ArtifactEngineFacts, 'repository'> {
    const state = this.shipping.get(appId);
    if (state?.lastBaseEncrypted === undefined) return {};
    return {
      repository: {
        objectKeyPrefix: this.artifactObjectPrefix(appId, state.generation),
        cipher: state.lastBaseEncrypted ? RCLONE_CRYPT_CIPHER : 'none',
      },
    };
  }

  /**
   * Answers by artifact, which the processor hands over only after the base
   * is recorded. Every non-`.bin` object under `mariadb/<appId>/` goes, in
   * every generation: bases and binary logs alike, since the encrypted base
   * is replayed only from encrypted logs.
   */
  async retirePlaintext(
    appId: string,
    latest: BackupArtifactEntity,
  ): Promise<void> {
    if (!isCryptSummary(latest.manifestSummary)) return;
    const destinationId = this.shipping.get(appId)?.destinationId;
    if (!destinationId) return;
    await this.retirement.afterEncryptedDatabaseBackup({
      appId,
      engine: this.engine,
      enginePrefix: artifactObjectPrefix(appId),
      destinationId,
      encryptedArtifactId: latest.id,
    });
  }

  /**
   * Takes a base backup and streams it straight to object storage, from the
   * shipper rather than the database: {@link baseBackupScript} says why.
   */
  async baseBackup(appId: string): Promise<string> {
    const target = await this.resolveTarget(appId);
    const state = this.shipping.get(appId);
    await awaitShipperConfig(this.k8s, target, state);
    const label = baseLabel(new Date());
    const out = await execInShipper(
      this.k8s,
      target,
      baseBackupScript(label, target.host, target.port),
    );
    if (!out.includes('FLUI_BASE_OK')) {
      throw new BadRequestException(BASE_INCOMPLETE);
    }
    const encrypted = /CIPHER=(\S+)/.exec(out)?.[1] === RCLONE_CRYPT_CIPHER;
    const compression = parseShipperCompression(out);
    if (state) {
      state.lastBaseEncrypted = encrypted;
      state.lastBaseCompression = compression;
    }
    this.logger.log(
      `[mariadb-pitr] base backup ${label} for app=${appId}${encrypted ? ' (encrypted)' : ' (unencrypted)'}, compression ${compression.type}`,
    );
    return label;
  }

  /**
   * The moment, then a binary log rotation: the file holding everything up to
   * the mark is closed, which is what the shipper carries off the cluster.
   * MariaDB has no named restore points; the moment and the position are the
   * point.
   */
  async markRestorePoint(appId: string): Promise<RestorePointMark> {
    const target = await this.resolveTarget(appId);
    const out = await execInDatabase(
      this.k8s,
      target,
      markRestorePointScript(mariadbClient(target)),
    );
    return parseRestorePoint(out);
  }

  /**
   * The window read from what actually reached object storage, never from the
   * server.
   *
   * The server knows what it wrote; only the repository knows what survived a
   * loss of the cluster, and that is the window a recovery can actually use.
   */
  async info(appId: string): Promise<{
    latestLabel: string | null;
    oldestRecoverable: string | null;
    newestRecoverable: string | null;
    backupCount: number;
  }> {
    return repositoryWindow(
      await listRepository(this.k8s, await this.resolveTarget(appId)),
    );
  }

  /**
   * A full base is the only kind MariaDB has, so the cadence of fulls is the
   * cadence of bases: between them the binary logs carry every change.
   *
   * The base can wait only when all of this is shown, and is due otherwise:
   * the shipper already reads the configuration this run just wrote (a
   * change of cipher or generation is a repository with no base yet), the
   * repository holds a base younger than `everyDays`, and its newest binary
   * log is within {@link SHIPPED_EDGE_TOLERANCE} of the server's.
   */
  async baseNotDue(
    appId: string,
    everyDays: number,
  ): Promise<BaseNotDue | null> {
    const target = await this.resolveTarget(appId);
    const state = this.shipping.get(appId);
    if (!state || !(await shipperConfigCurrent(this.k8s, target, state))) {
      return null;
    }
    const { bases } = await listRepository(this.k8s, target);
    const lastBaseAt = utcIso(bases.at(-1)?.at);
    if (!lastBaseAt) return null;
    const dueAt = nextBaseDue(lastBaseAt, everyDays, Date.now());
    if (!dueAt) return null;
    if (!(await shippedEdgeCurrent(this.k8s, target))) {
      this.logger.warn(
        `[mariadb-pitr] app=${appId}: the repository's binary logs trail the server's, so a base is taken instead of relying on them`,
      );
      return null;
    }
    return { lastBaseAt, dueAt: dueAt.toISOString() };
  }

  /** See {@link artifactObjectPrefix} in `mariadb-pitr.util.ts` for the why. */
  artifactObjectPrefix(appId: string, generation?: string): string {
    return artifactObjectPrefix(appId, generation);
  }

  /** See {@link mintGeneration} in `mariadb-pitr.util.ts` for the why. */
  mintGeneration(): string {
    return mintGeneration();
  }

  /** See {@link artifactObjectKeys} in `mariadb-pitr.util.ts` for the why. */
  artifactObjectKeys(
    appId: string,
    engineRef: string,
    generation?: string,
  ): string[] {
    return artifactObjectKeys(appId, engineRef, generation);
  }

  /** See {@link identityEnv} in `mariadb-pitr.util.ts` for the why. */
  identityEnv(identities: {
    user: string;
    database: string;
  }): Record<string, string> {
    return identityEnv(identities);
  }

  /** See {@link buildRestoreEnv} in `mariadb-pitr.util.ts` for the why. */
  buildRestoreEnv(
    sourceAppId: string,
    dest: BackupDestinationEntity,
    recoveryTargetTime?: Date | null,
    restoreSet?: string | null,
    generation?: string | null,
    artifactSummary?: Record<string, unknown>,
  ): Record<string, string> {
    return buildRestoreEnv(
      sourceAppId,
      dest,
      {
        accessKey: this.encryption.decrypt(dest.accessKeyEncrypted),
        secretKey: this.encryption.decrypt(dest.secretKeyEncrypted),
      },
      {
        recoveryTargetTime,
        restoreSet,
        generation,
        crypt: isCryptSummary(artifactSummary)
          ? restorePasswords(
              this.destinations.decryptPassphrase(dest),
              dest.name,
            )
          : undefined,
      },
    );
  }
}
