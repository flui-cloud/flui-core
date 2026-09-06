import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  CompanionsSpec,
  SidecarSpec,
  claimNameForVolume,
} from '../../applications/services/application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import { DestinationRole } from '../enums/destination-role.enum';

/** What one part of an application's data ended up doing. */
export type RestoredWith =
  | { kind: 'database'; what: string; from: string }
  | { kind: 'volume'; what: string; from: string }
  | { kind: 'empty'; what: string; why: string };

/** Names every companion this service adds, so a later run can replace them. */
const RESTORE_INIT_PREFIX = 'flui-restore-';
/** Every environment name this service writes, so all of them can be removed. */
const RESTORE_ENV_PREFIXES = ['RCLONE_CONFIG_FLUI_', 'FLUI_RESTORE_'];
const RESTORE_MOUNT = '/flui-restore';
const RCLONE_IMAGE = 'rclone/rclone:1.67';

/**
 * Declares the recovery on the application row so the workload is born reading
 * it: a database boots recovering, a volume is filled by an init container
 * before the application's container may start.
 *
 * A Job filling a claim the deploy then adopts was rejected: it would bind the
 * volume to its own node while the deploy picks another, leaving the pod
 * Pending forever on a node-affinity conflict. One pod is one node.
 */
@Injectable()
export class RebuildDataRestorer {
  private readonly logger = new Logger(RebuildDataRestorer.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    private readonly policyRepo: BackupPolicyRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly engines: ContinuousBackupEngineRegistry,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * A list rather than a verdict: an application can be a database with an
   * uploads directory beside it, and one answer hides whichever half failed.
   */
  async restoreInto(
    app: ApplicationEntity,
    to: ClusterEntity,
  ): Promise<RestoredWith[]> {
    void to;
    this.clearPreviousAttempt(app);
    const outcomes = await this.decide(app, false);
    await this.appRepo.save(app);
    return outcomes;
  }

  /** The same decision without writing anything, so the plan cannot drift
   * from what the rebuild does. */
  async preview(app: ApplicationEntity): Promise<RestoredWith[]> {
    return this.decide(app, true);
  }

  private async decide(
    app: ApplicationEntity,
    dryRun: boolean,
  ): Promise<RestoredWith[]> {
    const outcomes: RestoredWith[] = [];
    const database = await this.prepareDatabase(app, dryRun);
    if (database) outcomes.push(database);
    outcomes.push(
      ...(await this.prepareVolumes(app, database !== null, dryRun)),
    );
    return outcomes;
  }

  /**
   * Puts the rebuilt database back under the protection its policy claims.
   *
   * The image neutralises `archive_command` after a restore — the restored
   * config names a file that did not come with it — expecting whoever enables
   * backup to write the real one. A rebuild never enables: it moves the policy
   * row and stops. So the database came back with `archive_mode on` and
   * `archive_command '/bin/true'`, and `pg_stat_archiver` reported success with
   * zero failures while every segment was discarded, under a policy that read
   * enabled and active. Measured 13 hours after a rebuild.
   *
   * Re-arming alone is not enough: the segments already thrown away are
   * recycled, so the old base plus its logs cannot reach any moment after the
   * rebuild. A base taken now is what closes that.
   */
  async rearm(applicationId: string): Promise<string | null> {
    // On existence, not on `enabled`: pausing a database policy is defined as
    // "keep shipping WAL, stop taking bases", so a paused one still ships.
    const policy = await this.policyRepo.findDbPolicyForApp(applicationId);
    if (!policy) return null;

    const destination = await this.destinationOf(policy.destinations);
    if (!destination) {
      throw new Error(
        'the backup policy has no destination Flui holds credentials for, so ' +
          'WAL shipping cannot be re-armed and this database is not protected',
      );
    }

    const engine = this.engines.forEngine(policy.engine);
    await engine.awaitWritable?.(applicationId);

    // A new one, never the old: the rebuilt server restarts its log numbering,
    // so writing into the previous prefix overwrites files the earlier bases
    // point into and makes every one of them unrestorable, silently. Persisted
    // first — the scheduled run reads it from here, and would otherwise re-arm
    // tomorrow with the generation this call replaced.
    const generation = engine.mintGeneration?.();
    if (generation) {
      await this.policyRepo.update(policy.id, {
        metadata: { ...(policy.metadata ?? {}), generation },
      });
    }

    await engine.enable(applicationId, destination, {
      retentionFull: policy.retentionMaxCopies ?? 2,
      generation:
        generation ?? (policy.metadata?.generation as string | undefined),
    });
    this.logger.log(`[rebuild] ${applicationId}: WAL shipping re-armed`);
    return policy.id;
  }

  /**
   * Otherwise a live credential for someone else's repository stays in the
   * application's environment for as long as it exists. The running pod is
   * untouched; the next deploy renders clean.
   */
  async forget(applicationId: string): Promise<void> {
    const app = await this.appRepo.findOne({ where: { id: applicationId } });
    if (!app) return;
    if (!this.clearPreviousAttempt(app)) return;
    await this.appRepo.save(app);
    this.logger.log(`[rebuild] ${app.slug}: restore declaration removed`);
  }

  /** True when there was something to remove. */
  private clearPreviousAttempt(app: ApplicationEntity): boolean {
    const companions = (app.companions ?? {}) as CompanionsSpec;
    const inits = companions.initContainers ?? [];
    const keptInits = inits.filter(
      (c) => !c.name.startsWith(RESTORE_INIT_PREFIX),
    );

    const env = app.env ?? [];
    const keptEnv = env.filter(
      (e) => !RESTORE_ENV_PREFIXES.some((p) => e.name.startsWith(p)),
    );

    // The engines' own restore variables go too — same one boot.
    const enginePrefixes = this.engines.all().map((e) => e.restoreEnvPrefix);
    const finalEnv = keptEnv.filter(
      (e) => !enginePrefixes.some((p) => e.name.startsWith(p)),
    );

    const changed =
      keptInits.length !== inits.length || finalEnv.length !== env.length;
    if (!changed) return false;

    app.companions = {
      ...companions,
      initContainers: keptInits,
    } as ApplicationEntity['companions'];
    app.env = finalEnv as ApplicationEntity['env'];
    return true;
  }

  /**
   * Both engines recover into an empty data directory at first start, driven
   * by environment, so writing it on the row leaves no window in which the
   * application is up and empty. Null when there is no continuous backup.
   */
  private async prepareDatabase(
    app: ApplicationEntity,
    dryRun: boolean,
  ): Promise<RestoredWith | null> {
    const policy = await this.policyRepo.findDbPolicyForApp(app.id);
    if (!policy) return null;

    const artifact = await this.artifactRepo.findLatestDbArtifactForApp(app.id);
    if (!artifact) {
      return {
        kind: 'empty',
        what: 'database',
        why: 'continuous backup is on but no base backup exists yet',
      };
    }
    const destination = await this.destinationOf(artifact.locations);
    if (!destination) {
      return {
        kind: 'empty',
        what: 'database',
        why: 'the backup has no destination Flui holds credentials for',
      };
    }

    const engine = this.engines.forEngine(artifact.engine ?? policy.engine);
    // Neither instant nor label: both engines read the absence as "newest
    // base, then every log after it". Naming the label pinned recovery to when
    // that backup was taken — measured at 3h51m of WAL discarded, silently.
    const restoreEnv = engine.buildRestoreEnv(
      app.id,
      destination,
      undefined,
      undefined,
      (artifact.manifestSummary?.generation as string | undefined) ?? undefined,
    );
    const from = `${artifact.engineRef ?? artifact.id} and every log archived after it`;

    if (dryRun) {
      return { kind: 'database', what: 'database', from };
    }

    // The row is what the manifest is rendered from.
    app.env = [
      ...(app.env ?? []).filter(
        (e) => !e.name.startsWith(engine.restoreEnvPrefix),
      ),
      ...Object.entries(restoreEnv).map(([name, value]) => ({
        name,
        value,
        secret: /KEY|SECRET|PASSWORD/.test(name),
      })),
    ] as ApplicationEntity['env'];

    return { kind: 'database', what: 'database', from };
  }

  /** One init container per volume with a copy, a stated reason for the rest. */
  private async prepareVolumes(
    app: ApplicationEntity,
    databaseHandled: boolean,
    dryRun: boolean,
  ): Promise<RestoredWith[]> {
    const volumes = app.volumes ?? [];
    if (volumes.length === 0) return [];

    const outcomes: RestoredWith[] = [];
    const inits: SidecarSpec[] = [];
    let credentials: BackupDestinationEntity | null = null;

    for (const volume of volumes) {
      // The same name the ledger recorded the copy under: the copy names the
      // live PVC, and this is the rule that produced it on the lost cluster.
      const claim = claimNameForVolume(app, volume);
      const artifact = await this.artifactRepo.findLatestVolumeCopyForApp(
        app.id,
        claim,
      );
      if (!artifact) {
        outcomes.push({
          kind: 'empty',
          what: volume.name,
          // For a database under continuous backup the absence is correct.
          why: databaseHandled
            ? "no separate copy of this volume: the database's own data comes " +
              'back through its engine, anything else stored beside it does not'
            : 'no object-store copy has been taken, so it comes back empty',
        });
        continue;
      }

      // Seen by the copy's own preflight: a file copy of a running database
      // restores into something that does not start.
      const detected = artifact.manifestSummary?.dataDirectoryDetected as
        | string
        | undefined;
      if (detected) {
        outcomes.push({
          kind: 'empty',
          what: volume.name,
          why: databaseHandled
            ? `holds the ${detected} data directory — recovered through its engine, not as a file copy`
            : `holds a ${detected} data directory: a file copy of one does not restore. ` +
              'Enable continuous backup for this database so it can come back',
        });
        continue;
      }

      const destination = await this.destinationOf(artifact.locations);
      const prefix = artifact.locations?.find(
        (l) => l.role === DestinationRole.PRIMARY,
      )?.objectKeyPrefix;
      if (!destination || !prefix) {
        outcomes.push({
          kind: 'empty',
          what: volume.name,
          why: destination
            ? 'the copy was recorded without the path it was written to'
            : 'a copy exists but Flui holds no credentials for its bucket',
        });
        continue;
      }

      credentials ??= destination;
      if (destination.id !== credentials.id) {
        // One set of rclone variables serves the whole pod, so a second
        // bucket would be read with the first's credentials.
        outcomes.push({
          kind: 'empty',
          what: volume.name,
          why: 'its copy is in a different destination from another volume of the same application',
        });
        continue;
      }

      inits.push(this.restoreInitContainer(app, volume.name, prefix));
      outcomes.push({ kind: 'volume', what: volume.name, from: prefix });
    }

    if (dryRun) return outcomes;
    if (credentials && inits.length > 0) {
      this.declareRclone(app, credentials);
      const companions = (app.companions ?? {}) as CompanionsSpec;
      app.companions = {
        ...companions,
        initContainers: [...(companions.initContainers ?? []), ...inits],
      } as ApplicationEntity['companions'];
    }
    return outcomes;
  }

  /**
   * `copy`, never `sync`: a sync would delete what the application wrote after
   * a restart. The marker makes a second run a no-op anyway.
   *
   * Known limit: archives written before `--metadata` carry no uid or mode, so
   * files arrive owned by whoever ran this container.
   */
  private restoreInitContainer(
    app: ApplicationEntity,
    volumeName: string,
    prefix: string,
  ): SidecarSpec {
    const sc = app.securityContext as
      | { runAsUser?: number; fsGroup?: number; runAsGroup?: number }
      | undefined;
    const own =
      sc?.runAsUser === undefined
        ? ''
        : `${sc.runAsUser}:${sc.fsGroup ?? sc.runAsGroup ?? sc.runAsUser}`;

    const script = [
      'set -eu',
      `d=${RESTORE_MOUNT}`,
      'if [ -f "$d/.flui-restored" ]; then echo "flui: already restored"; exit 0; fi',
      'echo "flui: restoring $FLUI_RESTORE_PREFIX"',
      'rclone copy --metadata "flui:$FLUI_RESTORE_BUCKET/$FLUI_RESTORE_PREFIX" "$d" --transfers 8 --checkers 16 --stats 30s --stats-one-line',
      'if [ -n "${FLUI_RESTORE_OWN:-}" ]; then chown -R "$FLUI_RESTORE_OWN" "$d" || echo "flui: ownership unchanged"; fi',
      'date -u +%Y-%m-%dT%H:%M:%SZ > "$d/.flui-restored"',
      'echo "flui: restore complete"',
    ].join('\n');

    return {
      name: containerNameFor(volumeName),
      image: RCLONE_IMAGE,
      imagePullPolicy: 'IfNotPresent',
      command: ['/bin/sh', '-c', script],
      // The bucket and the credentials are the same for the whole pod and live
      // in the application's own Secret; only the path differs per volume.
      inheritAppEnv: true,
      env: [
        { name: 'FLUI_RESTORE_PREFIX', value: prefix },
        { name: 'FLUI_RESTORE_OWN', value: own },
      ],
      mounts: [{ name: volumeName, mountPath: RESTORE_MOUNT }],
      cpuRequest: '50m',
      memoryRequest: '64Mi',
      cpuLimit: '1000m',
      memoryLimit: '512Mi',
    };
  }

  /** From the environment, so the secret half lands in the application's
   * Secret rather than in the pod spec. */
  private declareRclone(
    app: ApplicationEntity,
    destination: BackupDestinationEntity,
  ): void {
    const values: Array<[string, string, boolean]> = [
      ['RCLONE_CONFIG_FLUI_TYPE', 's3', false],
      ['RCLONE_CONFIG_FLUI_PROVIDER', 'Other', false],
      ['RCLONE_CONFIG_FLUI_ENDPOINT', destination.endpoint, false],
      ['RCLONE_CONFIG_FLUI_REGION', destination.region || 'auto', false],
      [
        'RCLONE_CONFIG_FLUI_ACCESS_KEY_ID',
        this.encryption.decrypt(destination.accessKeyEncrypted),
        true,
      ],
      [
        'RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY',
        this.encryption.decrypt(destination.secretKeyEncrypted),
        true,
      ],
      ['FLUI_RESTORE_BUCKET', destination.bucket, false],
    ];
    app.env = [
      ...(app.env ?? []).filter(
        (e) => !RESTORE_ENV_PREFIXES.some((p) => e.name.startsWith(p)),
      ),
      ...values.map(([name, value, secret]) => ({ name, value, secret })),
    ] as ApplicationEntity['env'];
  }

  private async destinationOf(
    locations: Array<{ role: string; destinationId?: string }> | undefined,
  ): Promise<BackupDestinationEntity | null> {
    const id = locations?.find(
      (l) => l.role === DestinationRole.PRIMARY,
    )?.destinationId;
    return id ? await this.destRepo.findById(id) : null;
  }
}

/**
 * A DNS label: truncating a long volume name can end on a dash, and two
 * volumes sharing a prefix collide — either rejects the whole pod.
 */
function containerNameFor(volumeName: string): string {
  const natural = `${RESTORE_INIT_PREFIX}${volumeName}`.toLowerCase();
  if (natural.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(natural)) {
    return natural;
  }
  const digest = createHash('sha256')
    .update(volumeName)
    .digest('hex')
    .slice(0, 6);
  const stem = natural
    .replaceAll(/[^a-z0-9-]/g, '-')
    .slice(0, 63 - digest.length - 1)
    .replace(/-+$/, '');
  return `${stem}-${digest}`;
}
