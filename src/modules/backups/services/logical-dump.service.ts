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
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupDestinationsService } from './backup-destinations.service';
import { RestoreStrategy } from '../enums/restore-job.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { RCLONE_IMAGE } from '../backups.constants';
import {
  ArtifactEngineFacts,
  ContinuousBackupEngine,
} from './continuous-backup-engine.interface';
import {
  DumpFamily,
  dumpLabel,
  dumpLabelToIso,
  dumpObjectKey,
  dumpPrefix,
  renderDumpJob,
  dumpScript,
  loadScript,
  toolingProbe,
} from './logical-dump.util';
import { trimSlashes } from '../utils/destination-layout.util';

const JOB_TIMEOUT_SECONDS = 2 * 60 * 60;
const JOB_POLL_INTERVAL_MS = 5_000;

export interface DumpTarget {
  kubeconfig: string;
  namespace: string;
  appId: string;
  labelSelector: string;
  container: string;
  image: string;
  env: unknown[];
  envFrom: unknown[];
  imagePullSecrets: unknown[];
  tolerations: unknown[];
  host: string;
  port: number;
}

/**
 * Scheduled logical dumps for a database whose image cannot back itself up
 * continuously — the databases inside catalog bundles, which run the vendor's
 * own image.
 *
 * The dump runs in a Job built from the database's own image, so the dump
 * tool always matches the server, and borrows rclone from an init container,
 * because vendor images have no way to reach object storage. Credentials are
 * the workload's own: the Job reads the same env the database container reads.
 * A dump restores the moment it was taken and nothing after it; it is a
 * backup, not a point-in-time recovery.
 */
@Injectable()
abstract class LogicalDumpEngine implements ContinuousBackupEngine {
  abstract readonly engine: string;
  abstract readonly catalogSlug: string;
  abstract readonly family: DumpFamily;
  readonly restoreEnvPrefix = 'FLUI_DUMP_';
  readonly selfPrunesRepository = false;
  readonly replaysToEndWithoutTarget = true;
  readonly pointInTime = false;
  abstract readonly restoreStrategy: RestoreStrategy;

  protected readonly logger = new Logger(this.constructor.name);
  private readonly sizes = new Map<string, number>();

  constructor(
    protected readonly k8s: KubernetesService,
    protected readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    protected readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    protected readonly clusterRepo: Repository<ClusterEntity>,
    protected readonly policyRepo: BackupPolicyRepository,
    protected readonly destRepo: BackupDestinationRepository,
    protected readonly destinations: BackupDestinationsService,
    protected readonly storage: StorageBackendFactory,
  ) {}

  async resolveTarget(appId: string): Promise<DumpTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const labelSelector = `flui-app-id=${app.id}`;
    const pods = await this.k8s.listResourcesByLabel(
      kubeconfig,
      'Pod',
      app.k8sNamespace,
      labelSelector,
    );
    const pod = pods.find((p: any) => p?.status?.phase === 'Running');
    if (!pod) {
      throw new BadRequestException(
        'This database is not running, so it cannot be backed up. Start it and try again.',
      );
    }
    const containers: any[] = pod.spec?.containers ?? [];
    const container =
      containers.find((c) => c.name === app.slug) ?? containers[0];
    const services = await this.k8s.listResourcesByLabel(
      kubeconfig,
      'Service',
      app.k8sNamespace,
      labelSelector,
    );
    const service = services[0];
    const port = service?.spec?.ports?.[0]?.port ?? this.family.defaultPort;
    return {
      kubeconfig,
      namespace: app.k8sNamespace,
      appId: app.id,
      labelSelector,
      container: container.name,
      image: container.image,
      env: container.env ?? [],
      envFrom: container.envFrom ?? [],
      imagePullSecrets: pod.spec?.imagePullSecrets ?? [],
      tolerations: pod.spec?.tolerations ?? [],
      host: service
        ? `${service.metadata.name}.${app.k8sNamespace}.svc.cluster.local`
        : pod.status.podIP,
      port,
    };
  }

  private async exec(target: DumpTarget, script: string): Promise<string> {
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      target.container,
      ['sh', '-c', `echo ${b64} | base64 -d | sh`],
    );
  }

  async requireTooling(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    const out = await this.exec(target, toolingProbe(this.family));
    const missing = /MISSING:(\S+)/.exec(out);
    if (missing) {
      throw new BadRequestException(
        `This database cannot be dumped: its image has no ${missing[1]}. ` +
          'Back up its volume instead.',
      );
    }
  }

  async enable(appId: string): Promise<void> {
    await this.requireTooling(appId);
  }

  async disable(): Promise<void> {
    return;
  }

  artifactObjectPrefix(appId: string): string {
    return dumpPrefix(appId);
  }

  artifactObjectKeys(appId: string, engineRef: string): string[] {
    return [dumpObjectKey(appId, engineRef, this.family)];
  }

  identityEnv(): Record<string, string> {
    return {};
  }

  buildRestoreEnv(): Record<string, string> {
    return {};
  }

  private remoteFor(dest: BackupDestinationEntity, key: string): string {
    const prefix = trimSlashes(dest.pathPrefix);
    return `flui:${dest.bucket}/${prefix ? prefix + '/' : ''}${key}`;
  }

  private async primaryDestinationFor(
    appId: string,
  ): Promise<BackupDestinationEntity> {
    const policy = await this.policyRepo.findDbPolicyForApp(appId);
    const primary = policy?.destinations?.find(
      (d) => d.role === DestinationRole.PRIMARY,
    );
    const dest = primary
      ? await this.destRepo.findById(primary.destinationId)
      : null;
    if (!dest) {
      throw new NotFoundException(
        `No backup destination is recorded for database ${appId}`,
      );
    }
    return dest;
  }

  async baseBackup(appId: string): Promise<string> {
    const target = await this.resolveTarget(appId);
    const dest = await this.primaryDestinationFor(appId);
    const label = dumpLabel(new Date());
    const key = dumpObjectKey(appId, label, this.family);
    const out = await this.runJob(target, dest, {
      kind: 'dump',
      script: dumpScript(this.family),
      remote: this.remoteFor(dest, key),
    });
    const bytes = Number(/FLUI_DUMP_BYTES=(\d+)/.exec(out)?.[1]);
    if (Number.isFinite(bytes)) this.sizes.set(`${appId}/${label}`, bytes);
    const size = Number.isFinite(bytes) ? ` (${bytes} bytes)` : '';
    this.logger.log(`[dump] ${this.engine} app=${appId} → ${key}${size}`);
    return label;
  }

  /**
   * Load one dump into a freshly installed database of the same engine.
   *
   * The new install boots empty with its own role and database; the dump was
   * taken without owners or grants, so everything it creates belongs to that
   * role. Any error the loader reports fails the restore — a database that
   * loaded half its objects is not a restore.
   */
  async loadIntoRestored(
    newAppId: string,
    source: {
      sourceAppId: string;
      engineRef: string;
      destination: BackupDestinationEntity;
    },
  ): Promise<void> {
    const target = await this.resolveTarget(newAppId);
    const key = dumpObjectKey(
      source.sourceAppId,
      source.engineRef,
      this.family,
    );
    await this.runJob(target, source.destination, {
      kind: 'load',
      script: loadScript(this.family),
      remote: this.remoteFor(source.destination, key),
    });
    this.logger.log(`[dump] loaded ${key} into app=${newAppId}`);
  }

  private async runJob(
    target: DumpTarget,
    dest: BackupDestinationEntity,
    run: { kind: 'dump' | 'load'; script: string; remote: string },
  ): Promise<string> {
    const suffix = Date.now().toString(36);
    const jobName = `flui-${run.kind}-${target.appId.slice(0, 8)}-${suffix}`;
    const secretName = `${jobName}-s3`;
    const creds = {
      RCLONE_CONFIG_FLUI_TYPE: 's3',
      RCLONE_CONFIG_FLUI_PROVIDER: 'Other',
      RCLONE_CONFIG_FLUI_ACCESS_KEY_ID: this.encryption.decrypt(
        dest.accessKeyEncrypted,
      ),
      RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY: this.encryption.decrypt(
        dest.secretKeyEncrypted,
      ),
      RCLONE_CONFIG_FLUI_ENDPOINT: dest.endpoint,
      RCLONE_CONFIG_FLUI_REGION: dest.region || 'auto',
      RCLONE_CONFIG_FLUI_FORCE_PATH_STYLE: dest.forcePathStyle
        ? 'true'
        : 'false',
      FLUI_REMOTE: run.remote,
      FLUI_DB_HOST: target.host,
      FLUI_DB_PORT: String(target.port),
    };
    await this.k8s.applyManifest(
      target.kubeconfig,
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace: target.namespace,
          labels: { 'flui.cloud/dump-of': target.appId },
        },
        type: 'Opaque',
        stringData: creds,
      }),
    );
    try {
      await this.k8s.applyManifest(
        target.kubeconfig,
        JSON.stringify(
          renderDumpJob({
            jobName,
            namespace: target.namespace,
            appId: target.appId,
            image: target.image,
            rcloneImage: RCLONE_IMAGE,
            secretName,
            script: run.script,
            env: target.env,
            envFrom: target.envFrom,
            imagePullSecrets: target.imagePullSecrets,
            tolerations: target.tolerations,
            timeoutSeconds: JOB_TIMEOUT_SECONDS,
          }),
        ),
      );
      const outcome = await this.waitForJob(target, jobName);
      const logs = await this.jobLogs(target, jobName);
      if (!outcome) {
        const tail = logs.trim().split('\n').slice(-6).join(' | ');
        const detail = tail ? ': ' + tail : '';
        throw new Error(
          `The database ${run.kind === 'dump' ? 'dump' : 'load'} failed${detail}`,
        );
      }
      return logs;
    } finally {
      await this.k8s
        .deleteResource(target.kubeconfig, 'Job', jobName, target.namespace)
        .catch(() => undefined);
      await this.k8s
        .deleteResource(
          target.kubeconfig,
          'Secret',
          secretName,
          target.namespace,
        )
        .catch(() => undefined);
    }
  }

  private async waitForJob(
    target: DumpTarget,
    jobName: string,
  ): Promise<boolean> {
    const deadline = Date.now() + JOB_TIMEOUT_SECONDS * 1000;
    while (Date.now() < deadline) {
      const job = await this.k8s
        .getResource(target.kubeconfig, 'Job', jobName, target.namespace)
        .catch(() => null);
      if ((job?.status?.succeeded ?? 0) > 0) return true;
      if ((job?.status?.failed ?? 0) > 0) return false;
      await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
    }
    return false;
  }

  private async jobLogs(target: DumpTarget, jobName: string): Promise<string> {
    const pods = await this.k8s
      .listResourcesByLabel(
        target.kubeconfig,
        'Pod',
        target.namespace,
        `job-name=${jobName}`,
      )
      .catch(() => []);
    const pod = pods.at(-1);
    if (!pod) return '';
    return this.k8s
      .getPodLogs(
        target.kubeconfig,
        pod.metadata.name,
        target.namespace,
        'dump',
        200,
      )
      .catch(() => '');
  }

  async info(appId: string): Promise<{
    latestLabel: string | null;
    oldestRecoverable: string | null;
    newestRecoverable: string | null;
    backupCount: number;
    latestSizeBytes?: number | null;
  }> {
    const dest = await this.primaryDestinationFor(appId);
    const backend = this.storage.forProvider(dest.provider as any);
    const creds = this.destinations.toCredentials(dest);
    const labels = new Set<string>();
    let token: string | undefined;
    do {
      const page = await backend.listObjects(creds, dumpPrefix(appId), token);
      for (const key of page.keys) {
        const label = new RegExp(`${dumpPrefix(appId)}([^/]+)/`).exec(key)?.[1];
        if (label) labels.add(label);
      }
      token = page.hasMore ? page.continuationToken : undefined;
    } while (token);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    const latest = sorted.at(-1) ?? null;
    return {
      latestLabel: latest,
      oldestRecoverable: sorted[0] ? dumpLabelToIso(sorted[0]) : null,
      newestRecoverable: latest ? dumpLabelToIso(latest) : null,
      backupCount: sorted.length,
      latestSizeBytes: latest
        ? (this.sizes.get(`${appId}/${latest}`) ?? null)
        : null,
    };
  }

  async describeForArtifact(appId: string): Promise<ArtifactEngineFacts> {
    const target = await this.resolveTarget(appId);
    const read = async (script: string): Promise<string | undefined> => {
      try {
        return (await this.exec(target, script)).trim().split('\n').pop();
      } catch {
        return undefined;
      }
    };
    const identity = await read(this.family.identityScript);
    const [user = '', database = ''] = (identity ?? '').split('\t');
    return {
      engine: this.engine,
      engineVersion: await read(this.family.versionScript),
      tool: this.family.tool,
      toolVersion: await read(this.family.toolVersionScript),
      catalogSlug: this.catalogSlug,
      imageTag: target.image,
      identities: { user, database },
    };
  }
}

@Injectable()
export class PostgresDumpService extends LogicalDumpEngine {
  readonly engine = 'postgres-dump';
  readonly catalogSlug = 'postgresql';
  readonly restoreStrategy = RestoreStrategy.LOGICAL_DUMP;
  readonly family = DumpFamily.POSTGRES;
}

@Injectable()
export class MariadbDumpService extends LogicalDumpEngine {
  readonly engine = 'mariadb-dump';
  readonly catalogSlug = 'mariadb';
  readonly restoreStrategy = RestoreStrategy.LOGICAL_DUMP;
  readonly family = DumpFamily.MARIADB;
}
