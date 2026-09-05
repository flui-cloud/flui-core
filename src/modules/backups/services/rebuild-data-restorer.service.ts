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
 * Puts an application's data where the application will look for it, before it
 * looks — so a rebuilt application never starts empty and then gets filled.
 *
 * Both shapes work the same way, and deliberately so: the recovery is declared
 * on the application row, and the workload is born reading it. A database gets
 * the engine's restore environment, so its first start recovers instead of
 * initialising; a volume gets an init container that fills the claim before the
 * application's own container is allowed to run.
 *
 * The alternative — a Job that fills a claim the deploy then adopts — was
 * rejected after review. The claim would have to be pre-created byte-identical
 * to what the generator later renders, in a namespace that does not exist yet,
 * and its Job would bind the volume to whichever node it happened to land on
 * while the deploy picks a node of its own: a pod Pending forever on a volume
 * node-affinity conflict. One pod is one node, and that whole class disappears.
 *
 * Lives in the backups module because that is where the artifacts, policies and
 * engines already are; the rebuild asks it one question and learns none of it.
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
   * Everything this application has, decided one part at a time.
   *
   * A list rather than a verdict: an application can be a database with an
   * uploads directory beside it, and answering for the whole application hides
   * whichever half went badly.
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

  /**
   * The same decision, taken without writing anything.
   *
   * The plan has to say what the rebuild will do, and the only way for that to
   * stay true is for both to run the same code. A second implementation that
   * reads "probably restores" would drift the first time either changed.
   */
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
   * Takes the recovery back off the row once it has happened.
   *
   * What is left otherwise is a live credential for someone else's repository
   * sitting in the application's environment for as long as the application
   * exists, and an init container that runs on every deploy from here on. The
   * running pod is untouched — it already has what it needed — so this costs
   * nothing and the next deploy renders clean.
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

    // Anything the engines declared for their own restore goes with it: the
    // database path writes prefixed names for exactly the same one boot.
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
   * Boots the rebuilt database in restore mode instead of filling it after.
   *
   * Both engines already recover into an empty data directory at first start,
   * driven by environment: Postgres when `PG_VERSION` is absent, MariaDB from
   * its init container. Writing that environment onto the row the deploy
   * renders from means the server's first start reads recovered data — there
   * is no window in which the application is up and empty.
   *
   * Returns null when this application is not a database under continuous
   * backup, so the volume pass can still speak for it.
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
    // Neither an instant nor a base label, deliberately: both engines read the
    // absence as "the newest base, then every log archived after it", which is
    // the whole point of a continuous backup and the only sensible default for
    // a disaster.
    //
    // Naming the artifact's own label instead pinned recovery to the moment
    // that backup was taken. Measured on a real rebuild: the base was 3 hours
    // 51 minutes old, the WAL containing everything since was in the
    // repository and archived without error, and the database came back
    // missing all of it — reported as a success. Nothing but a marker written
    // on purpose would have shown it.
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

    // Onto the row, because the row is what the manifest is rendered from. The
    // catalog's declaration matters only at install; here the values are ours.
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

  /**
   * One init container per volume that has an object-store copy to come back
   * from, and a stated reason for every volume that does not.
   */
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
          // Two different situations wear the same shape. For a database under
          // continuous backup the absence of a volume copy is correct — its
          // data comes back through the engine — and reporting that as loss
          // would send someone to fix what is already working.
          why: databaseHandled
            ? "no separate copy of this volume: the database's own data comes " +
              'back through its engine, anything else stored beside it does not'
            : 'no object-store copy has been taken, so it comes back empty',
        });
        continue;
      }

      // Recorded by the copy's own preflight, from the volume itself. A file
      // copy of a running database restores into something that does not
      // start, and saying so is the whole point of having looked.
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
        // One set of rclone variables serves the whole pod, so two buckets in
        // one application would silently read the second from the first's
        // credentials. Rare enough to refuse rather than to design around.
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
   * `rclone copy`, never `sync`: a sync makes the claim match the bucket, and a
   * pod that restarts after the application has written would delete that work.
   * The marker makes the second run a no-op regardless.
   *
   * Ownership is the known limit. The archive carries no uid, gid or mode — the
   * copy that wrote it did not ask for them — so everything arrives owned by
   * whoever ran this container. When the application declares a user, that is
   * who runs it and the files are already right; when it does not, they are
   * root's, and an application that runs as somebody else can read them but not
   * write. Reported rather than papered over.
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

  /**
   * rclone reads its whole configuration from the environment, so the remote
   * needs no config file and the secret half lands in the application's Secret
   * rather than in the pod spec.
   */
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
 * A container name is a DNS label: lower-case, no trailing dash, 63 at most,
 * and unique within the pod. Truncating a long volume name satisfies none of
 * those on its own — it can end on a dash, and two volumes sharing a prefix
 * collapse onto the same name, which the API server rejects for the whole pod.
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
