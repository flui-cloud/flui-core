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
  MESSAGING_PROFILES,
  MessagingAuthProfile,
  detectMessagingEngine,
} from '../engine/messaging-engine';
import {
  MessagingCredentials,
  MessagingResolveInput,
  ResolvedMessagingConnection,
} from '../interfaces/messaging-connection';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';

/**
 * Resolves how to reach an installed messaging server's API. NATS' monitoring
 * endpoint is unauthenticated (the real boundary is the cluster-internal port +
 * the port-forward); RabbitMQ's management API needs the broker's owner
 * credentials, read from the install's generated K8s Secret + env — same
 * owner-secret pattern as the database/search consoles.
 */
@Injectable()
export class MessagingConnectionResolver {
  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async resolve({
    appId,
  }: MessagingResolveInput): Promise<ResolvedMessagingConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(`Messaging application ${appId} not found`);
    }
    assertNotPlatformFoundation(app);
    const engine = detectMessagingEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported messaging server`,
      );
    }
    const profile = MESSAGING_PROFILES[engine];
    const credentials = profile.auth
      ? await this.resolveCredentials(app, profile.auth)
      : undefined;
    return {
      engine,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.monitoringPort,
        clientPort: profile.clientPort,
      },
      credentials,
    };
  }

  private async resolveCredentials(
    app: ApplicationEntity,
    auth: MessagingAuthProfile,
  ): Promise<MessagingCredentials> {
    const username = this.firstEnv(app, auth.userEnvKeys) ?? auth.defaultUser;
    const password = await this.readSecretValue(app, auth.passwordSecretKeys);
    if (!password) {
      throw new NotFoundException(
        `Secret ${app.slug}-secret has none of [${auth.passwordSecretKeys.join(', ')}] in namespace ${app.k8sNamespace}`,
      );
    }
    return { username, password };
  }

  private firstEnv(
    app: ApplicationEntity,
    names: string[],
  ): string | undefined {
    for (const name of names) {
      const v = app.env?.find((e) => e.name === name)?.value;
      if (v) return v;
    }
    return undefined;
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
