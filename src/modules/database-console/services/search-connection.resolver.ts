import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { SEARCH_PROFILES, detectSearchEngine } from '../engine/search-engine';
import {
  ResolvedSearchConnection,
  SearchResolveInput,
} from '../interfaces/search-connection';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';

/**
 * Resolves how to reach an installed search engine + the admin credentials,
 * read from the building block's own generated K8s Secret. Mirrors
 * OwnerSecretConnectionResolver — owner creds for the MVP.
 */
@Injectable()
export class SearchConnectionResolver {
  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async resolve({
    appId,
  }: SearchResolveInput): Promise<ResolvedSearchConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(`Search application ${appId} not found`);
    }
    assertNotPlatformFoundation(app);
    const engine = detectSearchEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported search engine`,
      );
    }
    const profile = SEARCH_PROFILES[engine];
    const password = await this.readSecretValue(
      app,
      profile.passwordSecretKeys,
    );
    if (!password) {
      throw new NotFoundException(
        `Secret ${app.slug}-secret is missing the ${profile.label} admin password`,
      );
    }
    return {
      engine,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.httpPort,
      },
      username: profile.adminUser,
      password,
      useTls: profile.useTls,
    };
  }

  private async readSecretValue(
    app: ApplicationEntity,
    keys: string[],
  ): Promise<string | undefined> {
    const kubeconfig = await this.clusters.getKubeconfig(app.clusterId);
    const secret = await this.kubernetes
      .getResource(kubeconfig, 'Secret', `${app.slug}-secret`, app.k8sNamespace)
      .catch(() => undefined);
    const data = secret?.data as Record<string, string> | undefined;
    for (const key of keys) {
      const encoded = data?.[key];
      if (encoded) return Buffer.from(encoded, 'base64').toString('utf8');
    }
    return undefined;
  }
}
