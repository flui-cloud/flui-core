import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
} from '../flui-registry.config';
import { fluiImageName, registrySecretNames } from '../registry-image';
import { FluiRegistryClientService } from './flui-registry-client.service';
import { RegistryCredentialsService } from './registry-credentials.service';

export interface FluiPushTarget {
  host: string;
  imageName: string;
  secrets: { username: string; password: string };
}

/**
 * What the build and the cluster need to use the instance's own registry,
 * or nothing when the instance does not run one.
 */
@Injectable()
export class FluiRegistryPublisherService {
  private readonly logger = new Logger(FluiRegistryPublisherService.name);

  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly credentials: RegistryCredentialsService,
    private readonly client: FluiRegistryClientService,
  ) {}

  /** The registry host when new builds go to the instance's own registry. */
  host(): string | null {
    return this.config.mode === 'flui' ? this.config.host : null;
  }

  pushTarget(app: { id: string; slug: string }): FluiPushTarget | null {
    const host = this.host();
    if (!host) return null;
    return {
      host,
      imageName: fluiImageName(host, app.id),
      secrets: registrySecretNames(app.slug),
    };
  }

  issuePushCredential(applicationId: string) {
    return this.credentials.issue(applicationId, 'push');
  }

  issuePullCredential(applicationId: string) {
    return this.credentials.issue(applicationId, 'pull');
  }

  /**
   * What an application leaves on the registry when it goes: its credentials
   * at once, its images as far as the registry answers. A registry that cannot
   * be reached does not hold the deletion up — the credentials are already
   * dead, and the images are logged as left behind.
   */
  async forgetApplication(app: {
    id: string;
    imageRegistryHost?: string | null;
  }): Promise<void> {
    await this.credentials.revokeForApplication(app.id);
    if (!app.imageRegistryHost) return;
    try {
      const removed = await this.client.deleteRepository(app.id);
      this.logger.log(`Removed ${removed} image(s) of application ${app.id}`);
    } catch (error) {
      this.logger.warn(
        `Images of application ${app.id} left on the registry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
