import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';

export const VELERO_VOLUME_EXCLUDES =
  'backup.velero.io/backup-volumes-excludes';

/**
 * Keeps SQLite volumes out of the cluster backup when volume copies cover them.
 *
 * The cluster backup reads files as they are, so a SQLite database being
 * written comes back torn; the volume copy takes it with SQLite's own online
 * backup. Two rules for the same data would leave two copies of which one may
 * not open, so a volume whose off-cluster copy found SQLite is left to the
 * copies.
 *
 * Velero 1.14 cannot select volumes by claim, only by the pod annotation it
 * reads when the backup starts. The annotation goes on the running pods, not
 * on their template, so nothing restarts; a pod replaced later loses it and
 * gets it back at the next backup.
 */
@Injectable()
export class SqliteVolumeExclusionService {
  private readonly logger = new Logger(SqliteVolumeExclusionService.name);

  constructor(
    private readonly k8s: KubernetesService,
    @InjectRepository(BackupArtifactEntity)
    private readonly artifacts: Repository<BackupArtifactEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
  ) {}

  /** Returns the excluded volumes as `namespace/pod/volume`. */
  async excludeCoveredVolumes(
    kubeconfig: string,
    clusterId: string,
  ): Promise<string[]> {
    const rows: Array<{ applicationId: string; volumeName: string }> =
      await this.artifacts
        .createQueryBuilder('a')
        .select('a.applicationId', 'applicationId')
        .addSelect('a.volumeName', 'volumeName')
        .distinct(true)
        .where('a.clusterId = :clusterId', { clusterId })
        .andWhere('a.engineClass = :cls', {
          cls: BackupEngineClass.VOLUME_COPY,
        })
        .andWhere(`a."manifestSummary"->>'dataDirectoryDetected' = 'sqlite'`)
        .andWhere(`a."manifestSummary"->>'sink' = 's3-archive'`)
        .andWhere('a.applicationId IS NOT NULL')
        .andWhere('a.volumeName IS NOT NULL')
        .getRawMany();

    const excluded: string[] = [];
    for (const row of rows) {
      const app = await this.apps.findOne({
        where: { id: row.applicationId },
      });
      if (!app?.k8sNamespace) continue;
      const pods = await this.k8s
        .listResources(kubeconfig, 'pods', app.k8sNamespace)
        .catch(() => [] as any[]);
      for (const pod of pods) {
        const volume = (pod?.spec?.volumes ?? []).find(
          (v: any) => v?.persistentVolumeClaim?.claimName === row.volumeName,
        )?.name as string | undefined;
        if (!volume) continue;
        const current = String(
          pod?.metadata?.annotations?.[VELERO_VOLUME_EXCLUDES] ?? '',
        )
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
        if (!current.includes(volume)) {
          await this.k8s.mergePatchObject(kubeconfig, {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
              name: pod.metadata.name,
              namespace: app.k8sNamespace,
              annotations: {
                [VELERO_VOLUME_EXCLUDES]: [...current, volume].join(','),
              },
            },
          });
        }
        excluded.push(`${app.k8sNamespace}/${pod.metadata.name}/${volume}`);
      }
    }
    if (excluded.length) {
      this.logger.log(
        `[sqlite-exclusion] left to volume copies: ${excluded.join(', ')}`,
      );
    }
    return excluded;
  }
}
