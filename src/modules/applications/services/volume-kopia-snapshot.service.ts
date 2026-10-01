import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { IVolumeExport } from '../../providers/interfaces/volume-export.interface';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BackupDestinationEntity } from '../../backups/entities/backup-destination.entity';
import { BackupDestinationsService } from '../../backups/services/backup-destinations.service';
import { PlaintextRetirementService } from '../../backups/services/plaintext-retirement.service';
import {
  KOPIA_CIPHER,
  deriveKopiaPassword,
  kopiaLocation,
} from '../../backups/utils/kopia-repository.util';
import { kopiaRepositoryPrefix } from '../../backups/utils/destination-layout.util';
import {
  DEFAULT_KOPIA_RETENTION,
  kopiaVerifyDue,
} from '../../backups/utils/kopia-retention.util';
import {
  kopiaJobName,
  kopiaRepositoryLabel,
} from '../../backups/utils/kopia-job.manifest';
import {
  KopiaSnapshotOutcome,
  snapshotRecordFrom,
} from '../../backups/utils/kopia-snapshot-outcome.util';
import {
  VolumeCopyPreflightService,
  describeCopyRisk,
} from './volume-copy-preflight.service';
import { VolumePauseLeaseService } from './volume-pause-lease.service';
import { VolumeCopyLedgerService } from './volume-copy-ledger.service';
import { AppOperationRunner } from './app-operation-runner.service';
import {
  KopiaSourceVolume,
  KopiaVolumeEngineService,
} from './kopia-volume-engine.service';
import {
  BackupResponse,
  CreateBackupForAppRequest,
  ResolvedDestination,
} from './volume-backups.types';

export interface KopiaSnapshotContext {
  app: { id: string; slug: string; k8sNamespace: string };
  cluster: ClusterEntity;
  kubeconfig: string;
  ops: IVolumeExport;
  provider: CloudProvider;
}

@Injectable()
export class VolumeKopiaSnapshotService {
  private readonly logger = new Logger(VolumeKopiaSnapshotService.name);

  constructor(
    private readonly copyLedger: VolumeCopyLedgerService,
    private readonly preflight: VolumeCopyPreflightService,
    private readonly pauseLease: VolumePauseLeaseService,
    private readonly runner: AppOperationRunner,
    private readonly destinations: BackupDestinationsService,
    private readonly retirement: PlaintextRetirementService,
    private readonly kopia: KopiaVolumeEngineService,
  ) {}

  /**
   * One kopia snapshot of one volume into the application's repository on a
   * registered destination.
   *
   * The consistency preflight is the one every copy goes through — pause,
   * engine hook, SQLite online backup, refusal of a live data directory — and
   * kopia snapshots what it prepared, exactly as the archive did. A scheduled
   * snapshot follows the policy's retention; an ad-hoc one is pinned and stays
   * until a person removes it.
   */
  async create(
    request: CreateBackupForAppRequest,
    ctx: KopiaSnapshotContext,
    pvcName: string,
    destination: ResolvedDestination & { registered: BackupDestinationEntity },
  ): Promise<BackupResponse & { operationId: string }> {
    const { app, cluster, kubeconfig, ops, provider } = ctx;
    const registered = destination.registered;
    const password = deriveKopiaPassword(
      await this.destinations.passphraseFor(registered),
      app.id,
    );
    const location = kopiaLocation(
      { ...destination, pathPrefix: registered.pathPrefix },
      app.id,
    );
    const repositoryPrefix = kopiaRepositoryPrefix(app.id);
    const scheduled = !!request.policyId;
    const verify = kopiaVerifyDue(
      await this.copyLedger
        .lastKopiaVerification(app.id, registered.id)
        .catch(() => null),
      new Date(),
    );

    const { result, operationId } = await this.runner.run(
      {
        appId: app.id,
        operationType: OperationType.APP_BACKUP_CREATE,
        resourceName: app.slug,
        metadata: {
          pvcName,
          bucket: destination.bucket,
          keyPrefix: location.prefix,
          engine: 'kopia',
        },
        userId: request.userId,
        operationId: request.operationId,
      },
      async (): Promise<BackupResponse> => {
        const pausedAt = Date.now();
        const { facts, paused } = await this.preflight.check({
          kubeconfig,
          namespace: app.k8sNamespace,
          pvcName,
          allowInconsistent: request.allowInconsistent,
          pause: request.pause,
        });
        let source: KopiaSourceVolume;
        let outcome: KopiaSnapshotOutcome;
        try {
          source = await this.kopia.sourceVolume(
            kubeconfig,
            app.k8sNamespace,
            pvcName,
          );
          outcome = await this.kopia.snapshot({
            kubeconfig,
            repositoryKey: kopiaRepositoryLabel(registered.id, app.id),
            credentials: {
              password,
              accessKeyId: destination.accessKeyId,
              secretAccessKey: destination.secretAccessKey,
            },
            job: {
              jobName: kopiaJobName('snap', `${app.id}/${pvcName}/${uuid()}`),
              namespace: app.k8sNamespace,
              appId: app.id,
              volumeName: pvcName,
              location,
              retention: request.retention ?? DEFAULT_KOPIA_RETENTION,
              applyRetention: !!request.retention,
              pin: !scheduled,
              description: request.description ?? '',
              trigger: scheduled ? (request.trigger ?? 'scheduled') : 'manual',
              sqlite: facts.quiesce === 'sqlite-snapshot',
              verify,
              nodeName: source.nodeName,
              sizeGb: source.sizeGb,
              labels: {
                'flui.cloud/managed-by': 'flui-cloud',
                'flui-app-id': app.id,
                'flui.cloud/source-pvc': pvcName,
                'flui.cloud/backup-trigger': scheduled
                  ? (request.trigger ?? 'scheduled')
                  : 'manual',
              },
            },
          });
        } finally {
          await this.pauseLease.release(kubeconfig, paused);
        }
        const backReady = paused.length
          ? await this.pauseLease.waitUntilReady(kubeconfig, paused)
          : undefined;
        const interruptionSeconds = paused.length
          ? Math.round((Date.now() - pausedAt) / 1000)
          : undefined;

        const record = snapshotRecordFrom(outcome, {
          repositoryPrefix,
          pinned: !scheduled,
        });
        const verifiedNote = outcome.verified
          ? ` verify=${outcome.verified}`
          : '';
        this.logger.log(
          `[backup] kopia snapshot ${record.snapshotId} app=${app.slug} pvc=${pvcName} ` +
            `logical=${record.logicalBytes} uploaded=${record.uploadedBytes ?? '?'} ` +
            `maintenance=${outcome.maintenance ?? '?'}${verifiedNote}`,
        );
        const recorded = await this.copyLedger.record({
          clusterId: cluster.id,
          applicationId: app.id,
          applicationSlug: app.slug,
          volumeName: pvcName,
          userId: request.userId,
          exportId: record.snapshotId,
          sink: 'kopia',
          sizeBytes: record.logicalBytes,
          objectKeyPrefix: repositoryPrefix,
          bucket: destination.bucket,
          destinationId: registered.id,
          policyId: request.policyId,
          backupJobId: request.backupJobId,
          encryption: { cipher: KOPIA_CIPHER, mode: registered.encryptionMode },
          sourceSizeGb: source.sizeGb,
          kopia: record,
          ...facts,
        });
        await this.copyLedger.followKopiaRetention({
          applicationId: app.id,
          volumeName: pvcName,
          destinationId: registered.id,
          listed: outcome.listed,
        });
        if (recorded) {
          await this.retirement
            .afterEncryptedVolumeCopy({
              appId: app.id,
              volumeName: pvcName,
              encryptedArtifactId: recorded.id,
            })
            .catch((err: any) =>
              this.logger.warn(
                `[backup] plaintext copies of ${app.slug}/${pvcName} not retired: ${err?.message}`,
              ),
            );
        }
        const verifyWarning =
          outcome.verified === 'failed'
            ? 'The monthly spot check of this repository could not read back every sampled file. The new snapshot was taken, but older ones may be damaged: check the destination.'
            : undefined;
        return {
          exportId: record.snapshotId,
          appId: app.id,
          namespace: app.k8sNamespace,
          sourcePvcName: pvcName,
          sizeGb: source.sizeGb,
          actualBytes: record.logicalBytes,
          uploadedBytes: record.uploadedBytes,
          createdAt: new Date().toISOString(),
          ready: true,
          destination: {
            bucket: destination.bucket,
            endpoint: destination.endpoint,
            region: destination.region,
            keyPrefix: location.prefix,
          },
          provider,
          providerCapabilities: ops.capabilities,
          encrypted: true,
          engine: 'kopia',
          snapshotId: record.snapshotId,
          artifactId: recorded?.id,
          warning: describeCopyRisk(facts) ?? verifyWarning,
          ...(interruptionSeconds !== undefined
            ? { interruptionSeconds, applicationBack: backReady }
            : {}),
        };
      },
    );
    return { ...result, operationId };
  }
}
