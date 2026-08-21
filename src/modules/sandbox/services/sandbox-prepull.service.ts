import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { CatalogAppDefinitionEntity } from '../../catalog/entities/catalog-app-definition.entity';
import { CatalogAppType } from '../../catalog/enums/catalog-app-type.enum';
import { buildImageRef } from '../../catalog/utils/image-ref.util';
import { SANDBOX_FAST_CATALOG } from '../constants/sandbox-seed';
import { buildPrepullManifest } from '../constants/sandbox-prepull.manifest';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

/** Where a demo instance keeps the things that are the instance's, not a guest's. */
const SYSTEM_NAMESPACE = 'flui-system';

/**
 * Keeps the images the guided path offers already on the nodes.
 *
 * The manifest for this existed and nothing called it, which is the worse half
 * of the two possible states: an uncalled defence still counts itself among the
 * defences. Applying it is idempotent and a DaemonSet covers nodes that join
 * later on its own, so this runs on a slow clock rather than in the build path
 * — a guest waiting for an area must never wait for a cache to warm.
 */
@Injectable()
export class SandboxPrepullService {
  private readonly logger = new Logger(SandboxPrepullService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(CatalogAppDefinitionEntity)
    private readonly definitions: Repository<CatalogAppDefinitionEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /**
   * Every image a guest can reach from the guided path, including the databases
   * a composed entry brings with it — those are the slow pulls, and leaving
   * them out would warm the cheap half of the wait.
   */
  async imagesToWarm(): Promise<string[]> {
    const rows = await this.definitions.find({
      where: { slug: In(SANDBOX_FAST_CATALOG), isActive: true },
    });

    const images = new Set<string>();
    for (const row of rows) {
      const spec = row.manifest?.spec;
      if (!spec) continue;
      try {
        if (spec.type === CatalogAppType.COMPOSED) {
          for (const component of spec.components ?? []) {
            images.add(buildImageRef(component.image));
          }
        } else {
          images.add(buildImageRef(spec.image));
        }
      } catch (error) {
        // One unresolvable entry must not cost the warm cache of the others.
        this.logger.warn(
          `Skipping ${row.slug} in the pre-pull set: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return [...images].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Applies the DaemonSet on the sandbox cluster. Returns the images it covers,
   * or an empty list when there is nothing to do — no sandbox cluster, or a
   * catalog that has none of the fast entries seeded yet.
   */
  async warmImages(): Promise<string[]> {
    if (!this.config.clusterId) return [];

    const images = await this.imagesToWarm();
    if (images.length === 0) {
      this.logger.warn(
        'None of the sandbox catalog entries are seeded — nothing to pre-pull',
      );
      return [];
    }

    const cluster = await this.clusters.findOne({
      where: { id: this.config.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      this.logger.warn(
        `Sandbox cluster ${this.config.clusterId} has no kubeconfig — images stay cold`,
      );
      return [];
    }

    await this.k8s.applyManifest(
      this.encryption.decrypt(cluster.kubeconfigEncrypted),
      buildPrepullManifest(SYSTEM_NAMESPACE, images),
    );
    this.logger.log(
      `Pre-pulling ${images.length} catalog images on every sandbox node`,
    );
    return images;
  }
}
