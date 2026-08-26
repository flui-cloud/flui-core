import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import {
  SECRETS_PROFILES,
  detectSecretsEngine,
} from '../engine/secrets-engine';
import {
  ResolvedSecretsConnection,
  SecretsResolveInput,
} from '../interfaces/secrets-connection';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';

/**
 * Resolves how to reach an installed secrets server. The access token is NOT
 * read here — it is minted/read by the SecretsBootstrapService on first access
 * (OpenBao has no token until it is initialised). Pure target resolution keeps
 * all secret/token lifecycle inside the bootstrap.
 */
@Injectable()
export class SecretsConnectionResolver {
  constructor(private readonly applicationsRepo: ApplicationsRepository) {}

  async resolve({
    appId,
  }: SecretsResolveInput): Promise<ResolvedSecretsConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(`Secrets application ${appId} not found`);
    }
    assertNotPlatformFoundation(app);
    const engine = detectSecretsEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported secrets server`,
      );
    }
    const profile = SECRETS_PROFILES[engine];
    return {
      engine,
      slug: app.slug,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.port,
      },
      useTls: profile.useTls,
      mount: profile.mount,
    };
  }
}
