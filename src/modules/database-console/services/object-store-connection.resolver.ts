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
  OBJECT_STORE_PROFILES,
  detectObjectStoreEngine,
} from '../engine/object-store-engine';
import {
  ObjectStoreResolveInput,
  ResolvedObjectStoreConnection,
} from '../interfaces/object-store-connection';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';

/**
 * Resolves how to reach an installed object store + the S3 credentials to sign
 * requests, read from the building block's own generated K8s Secret (the
 * access/secret keys are `secret: true` env, so they live in the Secret, not as
 * plaintext). Mirrors OwnerSecretConnectionResolver — owner creds for the MVP;
 * a future per-user-key resolver can swap in behind the same shape.
 */
@Injectable()
export class ObjectStoreConnectionResolver {
  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async resolve({
    appId,
  }: ObjectStoreResolveInput): Promise<ResolvedObjectStoreConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(
        `Object store application ${appId} not found`,
      );
    }
    assertNotPlatformFoundation(app);
    const engine = detectObjectStoreEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported object store (unrecognized engine)`,
      );
    }
    const profile = OBJECT_STORE_PROFILES[engine];

    const secret = await this.readSecret(app);
    const accessKeyId = this.firstSecretValue(
      secret,
      profile.accessKeySecretKeys,
    );
    const secretAccessKey = this.firstSecretValue(
      secret,
      profile.secretKeySecretKeys,
    );
    if (!accessKeyId || !secretAccessKey) {
      throw new NotFoundException(
        `Secret ${app.slug}-secret is missing the S3 access/secret key for ${profile.label}`,
      );
    }

    return {
      engine,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.s3Port,
        adminPort: profile.adminPort,
      },
      region: profile.region,
      accessKeyId,
      secretAccessKey,
      adminToken: this.firstSecretValue(secret, profile.adminTokenSecretKeys),
      defaultBucket: this.firstEnv(app, profile.defaultBucketEnvKeys),
    };
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

  private async readSecret(
    app: ApplicationEntity,
  ): Promise<Record<string, string> | undefined> {
    const kubeconfig = await this.clusters.getKubeconfig(app.clusterId);
    const secret = await this.kubernetes
      .getResource(kubeconfig, 'Secret', `${app.slug}-secret`, app.k8sNamespace)
      .catch(() => undefined);
    return secret?.data as Record<string, string> | undefined;
  }

  private firstSecretValue(
    data: Record<string, string> | undefined,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const encoded = data?.[key];
      if (encoded) return Buffer.from(encoded, 'base64').toString('utf8');
    }
    return undefined;
  }
}
