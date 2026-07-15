import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationEntity } from '../entities/application.entity';
import {
  AppVariablesCombinedResponseDto,
  VariableScope,
  VariableType,
} from '../dto/app-config.dto';

type VariableScopeFilter = 'app' | 'system' | 'all';

// Raw result from list operations — type is added by the controller
type VariableSetRaw = {
  name: string;
  namespace: string;
  scope: VariableScope;
  resourceVersion?: string;
  keys: string[];
  data?: Record<string, string>;
};

// ── Internal response shapes (used only within this service layer) ─────────

interface ConfigResult {
  name: string;
  namespace: string;
  scope: VariableScope;
  data: Record<string, string>;
  resourceVersion?: string;
}

interface SecretResult {
  name: string;
  namespace: string;
  scope: VariableScope;
  keys: string[];
  resourceVersion?: string;
}

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  /** Variable sets that must never be overwritten via the API */
  private readonly PROTECTED_SECRETS = ['flui-secrets'];

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  // ── App-scoped ─────────────────────────────────────────────────────────

  async getAppConfig(appId: string): Promise<ConfigResult> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const name = this.configMapName(app.slug);

    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      name,
      app.k8sNamespace,
    );

    if (!resource) {
      return { name, namespace: app.k8sNamespace, scope: 'app', data: {} };
    }

    return {
      name,
      namespace: app.k8sNamespace,
      scope: 'app',
      data: resource.data ?? {},
      resourceVersion: resource.metadata?.resourceVersion,
    };
  }

  async upsertAppConfig(
    appId: string,
    data: Record<string, string>,
  ): Promise<ConfigResult> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const name = this.configMapName(app.slug);

    await this.kubernetesService.replaceManifest(
      kubeconfig,
      this.buildConfigMapManifest(app, name, data),
    );
    this.logger.log(`ConfigMap ${name} replaced for app ${appId}`);

    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      name,
      app.k8sNamespace,
    );

    return {
      name,
      namespace: app.k8sNamespace,
      scope: 'app',
      data: resource?.data ?? data,
      resourceVersion: resource?.metadata?.resourceVersion,
    };
  }

  async getAppSecret(appId: string): Promise<SecretResult> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const name = this.secretName(app.slug);

    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      'Secret',
      name,
      app.k8sNamespace,
    );

    if (!resource) {
      return { name, namespace: app.k8sNamespace, scope: 'app', keys: [] };
    }

    return {
      name,
      namespace: app.k8sNamespace,
      scope: 'app',
      keys: Object.keys(resource.data ?? {}),
      resourceVersion: resource.metadata?.resourceVersion,
    };
  }

  async upsertAppSecret(
    appId: string,
    data: Record<string, string>,
  ): Promise<SecretResult> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const name = this.secretName(app.slug);

    // Merge with existing secret — never drop keys not included in this payload
    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Secret',
      name,
      app.k8sNamespace,
    );
    const existingEncoded: Record<string, string> = existing?.data ?? {};

    // Encode only the new/updated keys and merge on top of existing encoded data
    const mergedData: Record<string, string> = { ...existingEncoded };
    for (const [key, value] of Object.entries(data)) {
      mergedData[key] = Buffer.from(value).toString('base64');
    }

    await this.kubernetesService.replaceManifest(
      kubeconfig,
      this.buildSecretManifestEncoded(app, name, mergedData),
    );
    this.logger.log(`Secret ${name} patched (merge) for app ${appId}`);

    return {
      name,
      namespace: app.k8sNamespace,
      scope: 'app',
      keys: Object.keys(mergedData),
    };
  }

  // ── App-scoped combined (plain + masked sensitive) ────────────────────

  async getAppVariablesCombined(
    appId: string,
    type: VariableType = VariableType.ALL,
  ): Promise<AppVariablesCombinedResponseDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);

    // Determine the correct workload kind from stored app resources
    const workloadKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
    const appResources = await this.appResourcesRepository.findByApplicationId(
      app.id,
    );
    const primaryResource = appResources.find((r) => workloadKinds.has(r.kind));
    const workloadKind = primaryResource?.kind ?? 'Deployment';

    // Discover which ConfigMaps and Secrets the workload actually uses
    let { configMaps, secrets } =
      await this.kubernetesService.getWorkloadEnvSources(
        kubeconfig,
        app.slug,
        app.k8sNamespace,
        workloadKind,
      );

    // Fallback when Deployment doesn't exist yet
    if (configMaps.length === 0 && secrets.length === 0) {
      configMaps = [this.configMapName(app.slug)];
      secrets = [this.secretName(app.slug)];
    }

    // Always read the app's own managed Secret (singular — the name the manifest
    // generator and building-block bootstraps write to), so keys patched
    // out-of-band (e.g. OpenBao's access token + unseal key) surface as masked
    // sensitive variables even when nothing references it via env/envFrom.
    const managedSecret = `${app.slug}-secret`;
    if (!secrets.includes(managedSecret)) secrets = [...secrets, managedSecret];

    const wantPlain = type === VariableType.PLAIN || type === VariableType.ALL;
    const wantSensitive =
      type === VariableType.SENSITIVE || type === VariableType.ALL;

    const cm = wantPlain
      ? await this.readConfigMapVars(kubeconfig, configMaps, app.k8sNamespace)
      : {
          used: [] as string[],
          data: {} as Record<string, string>,
          versions: {} as Record<string, string>,
        };
    const sec = wantSensitive
      ? await this.readSecretVars(kubeconfig, secrets, app.k8sNamespace)
      : {
          used: [] as string[],
          data: {} as Record<string, string>,
          versions: {} as Record<string, string>,
          sensitiveKeys: [] as string[],
        };

    return {
      name: app.slug,
      type,
      scope: 'app',
      data: { ...cm.data, ...sec.data },
      sensitiveKeys: sec.sensitiveKeys,
      sources: { configMaps: cm.used, secrets: sec.used },
      resourceVersions: { ...cm.versions, ...sec.versions },
    };
  }

  private async readConfigMapVars(
    kubeconfig: string,
    names: string[],
    namespace: string,
  ): Promise<{
    used: string[];
    data: Record<string, string>;
    versions: Record<string, string>;
  }> {
    const data: Record<string, string> = {};
    const versions: Record<string, string> = {};
    const used: string[] = [];
    for (const name of names) {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'ConfigMap',
        name,
        namespace,
      );
      if (!resource) continue;
      used.push(name);
      const rv = resource.metadata?.resourceVersion;
      if (rv) versions[name] = rv;
      Object.assign(data, resource.data ?? {});
    }
    return { used, data, versions };
  }

  private async readSecretVars(
    kubeconfig: string,
    names: string[],
    namespace: string,
  ): Promise<{
    used: string[];
    data: Record<string, string>;
    versions: Record<string, string>;
    sensitiveKeys: string[];
  }> {
    const data: Record<string, string> = {};
    const versions: Record<string, string> = {};
    const used: string[] = [];
    const sensitiveKeys: string[] = [];
    for (const name of names) {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Secret',
        name,
        namespace,
      );
      if (!resource) continue;
      used.push(name);
      const rv = resource.metadata?.resourceVersion;
      if (rv) versions[name] = rv;
      for (const key of Object.keys(resource.data ?? {})) {
        // Skip config-file payloads (Flui stores them as file-<i> keys in the
        // same Secret) — they are mounted files, not environment variables.
        if (/^file-\d+$/.test(key)) continue;
        data[key] = '****';
        sensitiveKeys.push(key);
      }
    }
    return { used, data, versions, sensitiveKeys };
  }

  // ── Cluster-scoped ─────────────────────────────────────────────────────

  async listClusterConfigs(
    clusterId: string,
    scope?: VariableScopeFilter,
    namespace = 'default',
  ): Promise<VariableSetRaw[]> {
    const { kubeconfig } = await this.resolveKubeconfig(clusterId);
    const items = await this.kubernetesService.listResources(
      kubeconfig,
      'ConfigMap',
      namespace,
      this.buildScopeLabelSelector(scope),
    );

    return items.map((item: any) => ({
      name: item.metadata?.name ?? '',
      namespace: item.metadata?.namespace ?? namespace,
      scope: this.readScope(item),
      resourceVersion: item.metadata?.resourceVersion,
      keys: Object.keys(item.data ?? {}),
      data: item.data ?? {},
    }));
  }

  async listClusterSecrets(
    clusterId: string,
    scope?: VariableScopeFilter,
    namespace = 'default',
  ): Promise<VariableSetRaw[]> {
    const { kubeconfig } = await this.resolveKubeconfig(clusterId);
    const items = await this.kubernetesService.listResources(
      kubeconfig,
      'Secret',
      namespace,
      this.buildScopeLabelSelector(scope),
    );

    return items.map((item: any) => ({
      name: item.metadata?.name ?? '',
      namespace: item.metadata?.namespace ?? namespace,
      scope: this.readScope(item),
      resourceVersion: item.metadata?.resourceVersion,
      keys: Object.keys(item.data ?? {}),
    }));
  }

  async getClusterConfig(
    clusterId: string,
    name: string,
    namespace = 'default',
  ): Promise<ConfigResult> {
    const { kubeconfig } = await this.resolveKubeconfig(clusterId);

    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      name,
      namespace,
    );

    if (!resource) {
      throw new NotFoundException(
        `Variable set "${name}" not found in namespace "${namespace}"`,
      );
    }

    return {
      name,
      namespace,
      scope: this.readScope(resource),
      data: resource.data ?? {},
      resourceVersion: resource.metadata?.resourceVersion,
    };
  }

  async upsertClusterConfig(
    clusterId: string,
    name: string,
    data: Record<string, string>,
    namespace = 'default',
  ): Promise<ConfigResult> {
    const { kubeconfig } = await this.resolveKubeconfig(clusterId);

    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      name,
      namespace,
    );
    const existingLabels: Record<string, string> =
      existing?.metadata?.labels ?? {};

    const labels: Record<string, string> = {
      'app.kubernetes.io/managed-by': 'flui-cloud',
      'flui.cloud/managed': 'true',
      'flui.cloud/scope': 'system',
      'flui.cloud/owner-kind': 'platform',
      'flui.cloud/owner-id': 'flui-core',
      ...existingLabels,
    };

    await this.kubernetesService.replaceManifest(
      kubeconfig,
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name, namespace, labels },
        data,
      }),
    );
    this.logger.log(`ConfigMap ${name} replaced for cluster ${clusterId}`);

    const updated = await this.kubernetesService.getResource(
      kubeconfig,
      'ConfigMap',
      name,
      namespace,
    );

    return {
      name,
      namespace,
      scope: this.readScope(updated ?? { metadata: { labels } }),
      data: updated?.data ?? data,
      resourceVersion: updated?.metadata?.resourceVersion,
    };
  }

  async getClusterSecret(
    clusterId: string,
    name: string,
    namespace = 'default',
  ): Promise<SecretResult> {
    const { kubeconfig } = await this.resolveKubeconfig(clusterId);

    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      'Secret',
      name,
      namespace,
    );

    if (!resource) {
      throw new NotFoundException(
        `Variable set "${name}" not found in namespace "${namespace}"`,
      );
    }

    return {
      name,
      namespace,
      scope: this.readScope(resource),
      keys: Object.keys(resource.data ?? {}),
      resourceVersion: resource.metadata?.resourceVersion,
    };
  }

  async upsertClusterSecret(
    clusterId: string,
    name: string,
    data: Record<string, string>,
    namespace = 'default',
  ): Promise<SecretResult> {
    if (this.PROTECTED_SECRETS.includes(name)) {
      throw new ForbiddenException(
        `Variable set "${name}" is protected and cannot be modified via the API`,
      );
    }

    const { kubeconfig } = await this.resolveKubeconfig(clusterId);

    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Secret',
      name,
      namespace,
    );
    const existingLabels: Record<string, string> =
      existing?.metadata?.labels ?? {};

    const labels: Record<string, string> = {
      'app.kubernetes.io/managed-by': 'flui-cloud',
      'flui.cloud/managed': 'true',
      'flui.cloud/scope': 'system',
      'flui.cloud/owner-kind': 'platform',
      'flui.cloud/owner-id': 'flui-core',
      ...existingLabels,
    };

    // Merge with existing secret data — never drop keys not in this payload
    const existingEncoded: Record<string, string> = existing?.data ?? {};
    const mergedData: Record<string, string> = { ...existingEncoded };
    for (const [key, value] of Object.entries(data)) {
      mergedData[key] = Buffer.from(value).toString('base64');
    }

    await this.kubernetesService.replaceManifest(
      kubeconfig,
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name, namespace, labels },
        type: 'Opaque',
        data: mergedData,
      }),
    );
    this.logger.log(`Secret ${name} patched (merge) for cluster ${clusterId}`);

    return {
      name,
      namespace,
      scope: this.readScope({ metadata: { labels } }),
      keys: Object.keys(mergedData),
    };
  }

  // ── Naming ─────────────────────────────────────────────────────────────

  configMapName(slug: string): string {
    return `${slug}-config`;
  }

  secretName(slug: string): string {
    return `${slug}-secrets`;
  }

  // ── Manifest builders ──────────────────────────────────────────────────

  private buildConfigMapManifest(
    app: ApplicationEntity,
    name: string,
    data: Record<string, string>,
  ): string {
    return JSON.stringify({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name,
        namespace: app.k8sNamespace,
        labels: this.buildAppLabels(app),
      },
      data,
    });
  }

  /** Builds a Secret manifest from already base64-encoded data */
  private buildSecretManifestEncoded(
    app: ApplicationEntity,
    name: string,
    encodedData: Record<string, string>,
  ): string {
    return JSON.stringify({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace: app.k8sNamespace,
        labels: this.buildAppLabels(app),
      },
      type: 'Opaque',
      data: encodedData,
    });
  }

  private buildAppLabels(app: ApplicationEntity): Record<string, string> {
    return {
      'app.kubernetes.io/name': app.slug,
      'app.kubernetes.io/instance': app.id,
      'app.kubernetes.io/managed-by': 'flui-cloud',
      'flui.cloud/managed': 'true',
      'flui.cloud/scope': 'app',
      'flui.cloud/owner-kind': 'application',
      'flui.cloud/owner-id': app.id,
      'flui.cloud/app-id': app.id,
      'flui.cloud/app-slug': app.slug,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private async resolveAppAndKubeconfig(
    appId: string,
  ): Promise<{ app: ApplicationEntity; kubeconfig: string }> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);

    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} has no kubeconfig available`,
      );
    }

    return {
      app,
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
    };
  }

  private async resolveKubeconfig(
    clusterId: string,
  ): Promise<{ kubeconfig: string; cluster: ClusterEntity }> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (!cluster.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${clusterId} has no kubeconfig available`,
      );
    }

    return {
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
      cluster,
    };
  }

  private buildScopeLabelSelector(scope?: VariableScopeFilter): string {
    const base = 'flui.cloud/managed=true';
    if (!scope || scope === 'all') return base;
    return `${base},flui.cloud/scope=${scope}`;
  }

  private readScope(resource: any): VariableScope {
    const label = resource?.metadata?.labels?.['flui.cloud/scope'];
    if (label === 'app' || label === 'system' || label === 'shared')
      return label;
    return 'system';
  }
}
