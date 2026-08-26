import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  FULLTEXT_PROFILES,
  FulltextAuthProfile,
  detectFulltextEngine,
} from '../engine/fulltext-engine';
import {
  FulltextResolveInput,
  ResolvedFulltextConnection,
} from '../interfaces/fulltext-connection';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';

/**
 * Resolves how to reach an installed full-text engine: cluster, namespace, pod
 * selector, port, and the master/API key from the install's generated Secret —
 * same owner-secret pattern as the other consoles.
 */
@Injectable()
export class FulltextConnectionResolver {
  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async resolve({
    appId,
  }: FulltextResolveInput): Promise<ResolvedFulltextConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(`Search application ${appId} not found`);
    }
    assertNotPlatformFoundation(app);
    const engine = detectFulltextEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported full-text engine`,
      );
    }
    const profile = FULLTEXT_PROFILES[engine];
    const apiKey = await this.resolveKey(app, profile.auth);
    return {
      engine,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.httpPort,
      },
      apiKey,
    };
  }

  private async resolveKey(
    app: ApplicationEntity,
    auth: FulltextAuthProfile,
  ): Promise<string | undefined> {
    const kubeconfig = await this.clusters.getKubeconfig(app.clusterId);
    const secret = await this.kubernetes
      .getResource(kubeconfig, 'Secret', `${app.slug}-secret`, app.k8sNamespace)
      .catch(() => undefined);
    const data = secret?.data as Record<string, string> | undefined;
    for (const key of auth.keySecretKeys) {
      const encoded = data?.[key];
      if (encoded) return Buffer.from(encoded, 'base64').toString('utf8');
    }
    return undefined;
  }
}
