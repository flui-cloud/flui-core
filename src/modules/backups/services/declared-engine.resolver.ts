import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';

const DB_ENGINE_LABEL = 'flui.cloud/db-engine';

/**
 * Reads the engine a workload declares, once, so a policy can remember it.
 *
 * The label is stamped at install time from the catalog manifest's `engine:`,
 * which makes it a statement about what the workload *is* rather than a guess
 * from an image name. It is read here exactly once — at policy creation — and
 * persisted, because the moment it matters most is a disaster restore, when
 * the workload it would be read from no longer exists.
 */
@Injectable()
export class DeclaredEngineResolver {
  private readonly logger = new Logger(DeclaredEngineResolver.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  async resolveForApp(appId: string): Promise<string | undefined> {
    try {
      const app = await this.appRepo.findOne({ where: { id: appId } });
      if (!app) return undefined;
      const cluster = await this.clusterRepo.findOne({
        where: { id: app.clusterId },
      });
      if (!cluster?.kubeconfigEncrypted) return undefined;
      const pods = await this.k8s.listResourcesByLabel(
        this.encryption.decrypt(cluster.kubeconfigEncrypted),
        'Pod',
        app.k8sNamespace,
        `flui-app-id=${app.id}`,
      );
      for (const pod of pods) {
        const declared = pod?.metadata?.labels?.[DB_ENGINE_LABEL];
        if (declared) return declared as string;
      }
      return undefined;
    } catch (err: any) {
      // Undefined, never a guess: the caller decides what an unknown engine
      // means, and for policy creation that is a refusal rather than a
      // default that would drive the wrong tool.
      this.logger.warn(
        `[declared-engine] could not read the engine for app=${appId}: ${err?.message}`,
      );
      return undefined;
    }
  }
}
