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
  KAFKA_PROFILES,
  KafkaAuthProfile,
  KafkaSaslCredentials,
  detectKafkaEngine,
} from '../engine/kafka-engine';
import {
  KafkaResolveInput,
  ResolvedKafkaConnection,
} from '../interfaces/kafka-connection';

/**
 * Resolves how to reach an installed Kafka broker: the workload cluster, the
 * install's namespace, the pod selector and the broker port. SASL credentials are
 * read from the install's generated Secret only when the profile declares auth —
 * the building-block install is PLAINTEXT (the real boundary is the port-forward).
 */
@Injectable()
export class KafkaConnectionResolver {
  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async resolve({
    appId,
  }: KafkaResolveInput): Promise<ResolvedKafkaConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app)
      throw new NotFoundException(`Kafka application ${appId} not found`);
    const engine = detectKafkaEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported Kafka server`,
      );
    }
    const profile = KAFKA_PROFILES[engine];
    const sasl = profile.auth
      ? await this.resolveSasl(app, profile.auth)
      : undefined;
    return {
      engine,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.clientPort,
      },
      sasl,
    };
  }

  private async resolveSasl(
    app: ApplicationEntity,
    auth: KafkaAuthProfile,
  ): Promise<KafkaSaslCredentials> {
    const username = this.firstEnv(app, auth.userEnvKeys) ?? auth.defaultUser;
    const password = await this.readSecretValue(app, auth.passwordSecretKeys);
    if (!password) {
      throw new NotFoundException(
        `Secret ${app.slug}-secret has none of [${auth.passwordSecretKeys.join(', ')}] in namespace ${app.k8sNamespace}`,
      );
    }
    return { mechanism: auth.mechanism, username, password };
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
