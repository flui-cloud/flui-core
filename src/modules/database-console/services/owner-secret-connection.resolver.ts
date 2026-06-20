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
  DbConnectionResolveInput,
  DbConnectionResolver,
  DbCredentials,
  DbEngine,
  ResolvedDbConnection,
} from '../interfaces/db-connection';
import {
  ENGINE_PROFILES,
  detectEngineFromImage,
} from '../engine/engine-profile';

function envValue(app: ApplicationEntity, name: string): string | undefined {
  return app.env?.find((e) => e.name === name)?.value;
}

function firstEnv(app: ApplicationEntity, names: string[]): string | undefined {
  for (const name of names) {
    const v = envValue(app, name);
    if (v) return v;
  }
  return undefined;
}

/**
 * MVP DbConnectionResolver: connects with the building-block's own owner/superuser
 * credentials, read from its generated K8s Secret. Family-agnostic — per-engine specifics
 * (env names, secret key, port, family) come from ENGINE_PROFILES. SQL engines carry
 * user+database; key-value engines authenticate with the password alone. The future
 * DedicatedUserConnectionResolver swaps in behind the same interface for per-user roles.
 */
@Injectable()
export class OwnerSecretConnectionResolver implements DbConnectionResolver {
  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async resolve({
    dbInstallId,
  }: DbConnectionResolveInput): Promise<ResolvedDbConnection> {
    const app = await this.applicationsRepo.findById(dbInstallId);
    if (!app) {
      throw new NotFoundException(
        `Database application ${dbInstallId} not found`,
      );
    }

    const engine = detectEngineFromImage(app.imageRef) ?? this.detectByEnv(app);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported database (unrecognized engine)`,
      );
    }
    const profile = ENGINE_PROFILES[engine];
    const credentials: DbCredentials = {};
    if (profile.family === 'sql') {
      credentials.password = await this.readSecretPassword(
        app,
        profile.secretPasswordKeys,
      );
      const user = firstEnv(app, profile.envUserKeys);
      const database = firstEnv(app, profile.envDatabaseKeys);
      if (!user || !database) {
        throw new BadRequestException(
          `Application ${app.id} is missing ${profile.label} user/database env vars`,
        );
      }
      credentials.user = user;
      credentials.database = database;
    } else if (profile.family === 'document') {
      // Document engines (FerretDB v2) authenticate with user + password against
      // authSource=admin — no fixed database. Password lives in the Secret; the
      // owner user is a plain env (FERRETDB_USER), mirroring the Postgres superuser.
      credentials.password = await this.readSecretPassword(
        app,
        profile.secretPasswordKeys,
      );
      credentials.user = firstEnv(app, profile.envUserKeys);
    } else {
      // Key-value caches (Redis/Valkey) are often deployed without auth — read the password if
      // present, otherwise connect anonymously. The real isolation boundary is network policy
      // (tracked in the shared backlog), not this password.
      credentials.password = await this.readSecretValue(
        app,
        profile.secretPasswordKeys,
      );
    }

    return {
      engine,
      role: 'owner',
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.defaultPort,
      },
      credentials,
    };
  }

  // SQL fallback when the image name isn't conclusive: an engine whose user+database env are set.
  private detectByEnv(app: ApplicationEntity): DbEngine | null {
    for (const profile of Object.values(ENGINE_PROFILES)) {
      if (profile.family !== 'sql') continue;
      const user = firstEnv(app, profile.envUserKeys);
      const database = firstEnv(app, profile.envDatabaseKeys);
      if (user && database) return profile.engine;
    }
    return null;
  }

  // Required password (SQL): throws if the Secret has none of the candidate keys.
  private async readSecretPassword(
    app: ApplicationEntity,
    keys: string[],
  ): Promise<string> {
    const value = await this.readSecretValue(app, keys);
    if (!value) {
      throw new NotFoundException(
        `Secret ${app.slug}-secret has none of [${keys.join(', ')}] in namespace ${app.k8sNamespace}`,
      );
    }
    return value;
  }

  // Optional read: returns the first candidate key present, or undefined (e.g. no-auth caches).
  private async readSecretValue(
    app: ApplicationEntity,
    keys: string[],
  ): Promise<string | undefined> {
    const kubeconfig = await this.clusters.getKubeconfig(app.clusterId);
    const secretName = `${app.slug}-secret`;
    const secret = await this.kubernetes
      .getResource(kubeconfig, 'Secret', secretName, app.k8sNamespace)
      .catch(() => undefined);
    const data = secret?.data as Record<string, string> | undefined;
    for (const key of keys) {
      const encoded = data?.[key];
      if (encoded) return Buffer.from(encoded, 'base64').toString('utf8');
    }
    return undefined;
  }
}
