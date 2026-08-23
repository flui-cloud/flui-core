import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKeyService } from '../services/api-key.service';
import { SERVICE_IDENTITY } from '../constants/service-identities';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../../infrastructure/clusters/entities/cluster-node.entity';
import { ApiTokenEntity } from '../../access/entities/api-token.entity';
import { ProviderConfigurationEntity } from '../../management/entities/provider-configuration.entity';
import { ProviderStatus } from '../../management/entities/provider-status.enum';
import { FirewallEntity } from '../../infrastructure/firewalls/entities/firewall.entity';
import {
  VNetEntity,
  VNetStatus,
} from '../../infrastructure/vnets/entities/vnet.entity';
import {
  VNetSubnetEntity,
  SubnetType,
} from '../../infrastructure/vnets/entities/vnet-subnet.entity';
import { CAManagerService } from '../../access/services/ca-manager.service';
import { KeyStorageService } from '../../access/services/key-storage.service';
import { SystemAppCatalogService } from '../../applications/services/system-app-catalog.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import {
  PROVIDER_BOOTSTRAP_SEEDER_REGISTRY,
  ProviderBootstrapSeederRegistration,
} from '../../providers/core/tokens';
import { FirewallDesiredStateService } from '../../infrastructure/firewalls/services/firewall-desired-state.service';
import { FirewallProviderFactory } from '../../providers/core/factories/firewall-provider.factory';
import { BillingIntervalsService } from '../../infrastructure/clusters/services/billing-intervals.service';
import { VolumeBillableKind } from '../../infrastructure/clusters/entities/volume-billable-interval.entity';

/**
 * BootstrapSeeder — runs on API startup via OnModuleInit.
 *
 * Reads cluster metadata from environment variables (injected into
 * the pod via flui-secrets K8s Secret during bootstrap) and populates
 * the database idempotently. No HTTP calls required from the CLI.
 *
 * Environment variables read:
 *   FLUI_CLI_API_KEY          — pre-generated CLI API key (flui_*)
 *   FLUI_CA_PUBLIC_KEY        — SSH CA public key from CLI (~/.flui/ca/ca_key.pub)
 *   PROVIDER_HETZNER_API_KEY  — Hetzner cloud API token
 *   PROVIDER_REGIONS          — comma-separated list of enabled regions
 *   CLUSTER_ID                — cluster UUID (set by CLI during creation)
 *   CLUSTER_NAME              — cluster display name
 *   CLOUD_PROVIDER            — cloud provider enum value
 *   CLUSTER_REGION            — cluster region
 *   INSTANCE_TYPE             — master node size
 *   MASTER_IP                 — master node IP address
 *   SERVER_ID                 — master node UUID
 *   INSTANCE_ID               — cloud provider resource ID for the master server
 *   INSTANCE_NAME             — server name on provider
 *   K3S_TOKEN                 — K3s join token (stored as-is, already a secret)
 *   K3S_VERSION               — K3s version string
 *   CLUSTER_FIREWALL_ID       — cloud provider firewall ID (optional)
 */
@Injectable()
export class BootstrapSeeder implements OnModuleInit {
  private readonly logger = new Logger(BootstrapSeeder.name);

  constructor(
    private readonly apiKeys: ApiKeyService,
    @InjectRepository(ApiTokenEntity)
    private readonly apiTokenRepo: Repository<ApiTokenEntity>,
    @InjectRepository(ProviderConfigurationEntity)
    private readonly providerConfigRepo: Repository<ProviderConfigurationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly clusterNodeRepo: Repository<ClusterNodeEntity>,
    @InjectRepository(FirewallEntity)
    private readonly firewallRepo: Repository<FirewallEntity>,
    @InjectRepository(VNetEntity)
    private readonly vnetRepo: Repository<VNetEntity>,
    @InjectRepository(VNetSubnetEntity)
    private readonly vnetSubnetRepo: Repository<VNetSubnetEntity>,
    private readonly caManager: CAManagerService,
    private readonly keyStorage: KeyStorageService,
    private readonly systemAppCatalogService: SystemAppCatalogService,
    private readonly encryptionService: EncryptionService,
    private readonly firewallDesiredState: FirewallDesiredStateService,
    private readonly firewallProviderFactory: FirewallProviderFactory,
    @Optional()
    @Inject(PROVIDER_BOOTSTRAP_SEEDER_REGISTRY)
    private readonly bootstrapSeeders:
      | ProviderBootstrapSeederRegistration[]
      | null,
    private readonly billingIntervals: BillingIntervalsService,
  ) {}

  async onModuleInit() {
    this.logEnvSummary();

    const results: Record<string, 'ok' | 'skipped' | 'error'> = {};

    try {
      await this.seedCliApiKey();
      results.apiKey = 'ok';
    } catch (e) {
      results.apiKey = 'error';
      this.logger.error(`seedCliApiKey failed: ${e.message}`);
    }

    try {
      await this.seedCa();
      results.ca = 'ok';
    } catch (e) {
      results.ca = 'error';
      this.logger.error(`seedCa failed: ${e.message}`);
    }

    try {
      await this.seedProvider();
      results.provider = 'ok';
    } catch (e) {
      results.provider = 'error';
      this.logger.error(`seedProvider failed: ${e.message}`);
    }

    let vnetSeed: { vnetId: string; subnetId: string } | null = null;
    try {
      vnetSeed = await this.seedVnetAndSubnet();
      results.vnet = 'ok';
    } catch (e) {
      results.vnet = 'error';
      this.logger.error(`seedVnetAndSubnet failed: ${e.message}`);
    }

    let clusterId: string | null = null;
    try {
      clusterId = await this.seedCluster(vnetSeed);
      results.cluster = 'ok';
    } catch (e) {
      results.cluster = 'error';
      this.logger.error(`seedCluster failed: ${e.message}`);
    }

    if (clusterId) {
      try {
        await this.seedFirewall(clusterId);
        results.firewall = 'ok';
      } catch (e) {
        results.firewall = 'error';
        this.logger.error(`seedFirewall failed: ${e.message}`);
      }

      try {
        await this.seedClusterFirewall(clusterId);
        results.clusterFirewall = 'ok';
      } catch (e) {
        results.clusterFirewall = 'error';
        this.logger.error(`seedClusterFirewall failed: ${e.message}`);
      }

      try {
        await this.seedSystemApps(clusterId);
        results.systemApps = 'ok';
      } catch (e) {
        results.systemApps = 'error';
        this.logger.error(`seedSystemApps failed: ${e.message}`);
      }
    } else {
      results.firewall = 'skipped';
      results.clusterFirewall = 'skipped';
      results.systemApps = 'skipped';
    }

    try {
      const allClusters = await this.clusterRepo.find({ relations: ['nodes'] });
      const opened =
        await this.billingIntervals.backfillFromClusters(allClusters);
      if (opened.nodes > 0 || opened.volumes > 0) {
        this.logger.log(
          `✅ Billing intervals backfilled: ${opened.nodes} node(s), ${opened.volumes} volume(s)`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Billing intervals backfill failed: ${(e as Error).message}`,
      );
    }

    this.logBootstrapSummary(results);
  }

  private logEnvSummary(): void {
    const vars = {
      FLUI_CLI_API_KEY: process.env.FLUI_CLI_API_KEY
        ? `${process.env.FLUI_CLI_API_KEY.substring(0, 10)}…`
        : '(missing)',
      FLUI_CA_PUBLIC_KEY: process.env.FLUI_CA_PUBLIC_KEY
        ? '(present)'
        : '(missing)',
      PROVIDER_HETZNER_API_KEY: process.env.PROVIDER_HETZNER_API_KEY
        ? '(present)'
        : '(missing)',
      PROVIDER_SCALEWAY_ACCESS_KEY: process.env.PROVIDER_SCALEWAY_ACCESS_KEY
        ? '(present)'
        : '(missing)',
      PROVIDER_SCALEWAY_SECRET_KEY: process.env.PROVIDER_SCALEWAY_SECRET_KEY
        ? '(present)'
        : '(missing)',
      PROVIDER_REGIONS: process.env.PROVIDER_REGIONS || '(missing)',
      CLUSTER_ID: process.env.CLUSTER_ID || '(missing)',
      CLUSTER_NAME: process.env.CLUSTER_NAME || '(missing)',
      CLOUD_PROVIDER: process.env.CLOUD_PROVIDER || '(missing)',
      CLUSTER_REGION: process.env.CLUSTER_REGION || '(missing)',
      INSTANCE_TYPE: process.env.INSTANCE_TYPE || '(missing)',
      MASTER_IP: process.env.MASTER_IP || '(missing)',
      SERVER_ID: process.env.SERVER_ID || '(missing)',
      K3S_TOKEN: process.env.K3S_TOKEN ? '(present)' : '(missing)',
      K3S_VERSION: process.env.K3S_VERSION || '(missing)',
      CLUSTER_FIREWALL_ID: process.env.CLUSTER_FIREWALL_ID || '(missing)',
      KUBECONFIG_CONTENT: process.env.KUBECONFIG_CONTENT
        ? '(present)'
        : '(missing)',
      FLUI_VNET_PROVIDER_RESOURCE_ID:
        process.env.FLUI_VNET_PROVIDER_RESOURCE_ID || '(missing)',
      FLUI_SUBNET_PROVIDER_RESOURCE_ID:
        process.env.FLUI_SUBNET_PROVIDER_RESOURCE_ID || '(missing)',
      FLUI_SUBNET_IP_RANGE: process.env.FLUI_SUBNET_IP_RANGE || '(missing)',
      FLUI_BOOTSTRAP_NODE_PRIVATE_IP:
        process.env.FLUI_BOOTSTRAP_NODE_PRIVATE_IP || '(missing)',
    };
    this.logger.log('━━━ BootstrapSeeder starting ━━━');
    for (const [key, value] of Object.entries(vars)) {
      this.logger.log(`  ${key}: ${value}`);
    }
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  private logBootstrapSummary(
    results: Record<string, 'ok' | 'skipped' | 'error'>,
  ): void {
    const icons = { ok: '✅', skipped: '⏭ ', error: '❌' };
    const errors = Object.values(results).filter((v) => v === 'error').length;
    this.logger.log('━━━ BootstrapSeeder summary ━━━━');
    for (const [step, status] of Object.entries(results)) {
      this.logger.log(`  ${icons[status]} ${step}: ${status}`);
    }
    if (errors > 0) {
      this.logger.warn(`  ⚠ ${errors} step(s) failed — check errors above`);
    } else {
      this.logger.log('  Bootstrap seeding completed successfully');
    }
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  /**
   * Seed CLI API key from FLUI_CLI_API_KEY env var.
   */
  private async seedCliApiKey(): Promise<void> {
    const apiKey = process.env.FLUI_CLI_API_KEY;
    if (!apiKey) return;

    // Through the service, not the repository: the stored value is a digest
    // and exactly one place is allowed to know that. `userId` is written so the
    // row says which declared identity it is, instead of leaving
    // ApiKeyStrategy to infer one from an absent userId.
    const outcome = await this.apiKeys.adoptExternalKey(
      apiKey,
      SERVICE_IDENTITY.CLI_BOOTSTRAP.keyName,
      SERVICE_IDENTITY.CLI_BOOTSTRAP.id,
    );
    if (outcome === 'already-present') {
      this.logger.debug('CLI API key already seeded');
      return;
    }
    this.logger.log('✅ CLI API key seeded');
  }

  /**
   * Seed the SSH CA from env vars (workstation CA copied into the cluster
   * Secret at create-time). FLUI_CA_PUBLIC_KEY (or SSH_CA_PUBLIC_KEY) provides
   * the public half; SSH_CA_PRIVATE_KEY, when present, provides the private
   * half that signs ephemeral certs for in-cluster SSH (Dashboard terminal,
   * resize2fs, etc). If only the public is set the seeder still registers it
   * but the API will be unable to sign certs until the private is provided.
   */
  private async seedCa(): Promise<void> {
    const caPublicKey =
      process.env.FLUI_CA_PUBLIC_KEY || process.env.SSH_CA_PUBLIC_KEY;
    const caPrivateKey = process.env.SSH_CA_PRIVATE_KEY;
    if (!caPublicKey) return;

    try {
      const existing = await this.caManager.getActiveCA();
      if (existing) {
        if (!existing.encryptedPrivateKey && caPrivateKey) {
          await this.caManager.attachPrivateKey(existing.id, caPrivateKey);
          this.logger.log('✅ CA private key backfilled on existing CA row');
        } else {
          this.logger.debug('CA already seeded');
        }
        return;
      }

      await this.caManager.registerExternalCA(caPublicKey, {
        name: 'cli-ca',
        replace: false,
        metadata: { source: 'bootstrap-seeder' },
        privateKey: caPrivateKey || undefined,
      });
      this.logger.log(
        caPrivateKey
          ? '✅ CA public + private key seeded'
          : '⚠️ CA public key seeded (private missing — terminal/SSH ops will fail)',
      );
    } catch (error) {
      this.logger.warn(`CA seeding skipped: ${error.message}`);
    }
  }

  /**
   * Seed cloud provider API credentials and configuration.
   *
   * Generic dispatcher: looks up the right `IProviderBootstrapSeeder` from
   * the registry (by `CLOUD_PROVIDER` env var) and persists what it returns.
   * Provider-specific shape (single token vs access/secret pair, env var
   * names, etc.) lives in the provider implementation modules — this
   * orchestrator stays provider-agnostic.
   */
  private async seedProvider(): Promise<void> {
    const cloudProvider = (
      process.env.CLOUD_PROVIDER || ''
    ).toLowerCase() as CloudProvider;
    if (!cloudProvider) {
      this.logger.debug('CLOUD_PROVIDER not set — skipping provider seeding');
      return;
    }

    const seeder = this.findSeeder(cloudProvider);
    if (!seeder) {
      this.logger.warn(
        `No bootstrap seeder registered for provider ${cloudProvider}`,
      );
      return;
    }

    const credentials = seeder.buildCredentials(process.env);
    if (!credentials) {
      this.logger.debug(
        `No credentials env vars present for provider ${cloudProvider}`,
      );
      return;
    }

    const existingToken = await this.apiTokenRepo.findOne({
      where: { provider: cloudProvider, is_active: true },
    });
    if (existingToken) {
      this.logger.debug(`Provider token for ${cloudProvider} already seeded`);
    } else {
      await this.apiTokenRepo.save({
        provider: cloudProvider,
        credential_type: credentials.credentialType,
        label: credentials.label,
        notes:
          credentials.notes ||
          'Auto-seeded from flui-secrets at cluster bootstrap',
        encrypted_token: this.keyStorage.encryptKeyToString(credentials.token),
        encrypted_access_key: credentials.accessKey
          ? this.keyStorage.encryptKeyToString(credentials.accessKey)
          : undefined,
        is_active: true,
      });
      this.logger.log(`✅ Provider credentials seeded (${cloudProvider})`);
    }

    const existingConfig = await this.providerConfigRepo.findOne({
      where: { provider: cloudProvider },
    });
    if (existingConfig) {
      this.logger.debug(
        `Provider configuration for ${cloudProvider} already seeded`,
      );
      return;
    }

    const regions = process.env.PROVIDER_REGIONS
      ? process.env.PROVIDER_REGIONS.split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [];

    await this.providerConfigRepo.save({
      provider: cloudProvider,
      status: ProviderStatus.ACTIVE,
      enabledRegions: regions,
      configuration: {},
      isActive: true,
      metadata: { source: 'bootstrap-seeder' },
    });
    this.logger.log(`✅ Provider configuration seeded (${cloudProvider})`);
  }

  private findSeeder(provider: CloudProvider) {
    return (this.bootstrapSeeders ?? []).find((r) => r.provider === provider)
      ?.service;
  }

  /**
   * Seed environment VNet + Subnet from FLUI_VNET_* / FLUI_SUBNET_* env vars.
   * The CLI provisions the network on the cloud provider during `flui env create`
   * and injects the resource IDs here. Returns the seeded subnet's local UUID,
   * or null if env vars are missing (legacy bootstrap path).
   */
  private async seedVnetAndSubnet(): Promise<{
    vnetId: string;
    subnetId: string;
  } | null> {
    const vnetProviderResourceId = process.env.FLUI_VNET_PROVIDER_RESOURCE_ID;
    const subnetProviderResourceId =
      process.env.FLUI_SUBNET_PROVIDER_RESOURCE_ID;
    if (!vnetProviderResourceId || !subnetProviderResourceId) return null;

    const provider =
      (process.env.FLUI_VNET_PROVIDER as CloudProvider) ||
      (process.env.CLOUD_PROVIDER as CloudProvider) ||
      CloudProvider.HETZNER;

    const clusterId = process.env.CLUSTER_ID;
    const baseLabels = [
      { key: 'managed-by', value: 'flui-cloud' },
      { key: 'flui-resource-type', value: 'vnet' },
      ...(clusterId ? [{ key: 'flui-cluster-id', value: clusterId }] : []),
    ];

    const vnet = await this.upsertVnet({
      vnetProviderResourceId,
      provider,
      clusterId,
      baseLabels,
    });

    let subnet = await this.vnetSubnetRepo.findOne({
      where: { vnetId: vnet.id, providerSubnetId: subnetProviderResourceId },
    });
    if (subnet) {
      this.logger.debug('Subnet already seeded');
    } else {
      const subnetTypeRaw = (
        process.env.FLUI_SUBNET_TYPE || 'cloud'
      ).toLowerCase();
      let subnetType: SubnetType;
      if (subnetTypeRaw === 'server') subnetType = SubnetType.SERVER;
      else if (subnetTypeRaw === 'vswitch') subnetType = SubnetType.VSWITCH;
      else subnetType = SubnetType.CLOUD;

      subnet = await this.vnetSubnetRepo.save({
        vnetId: vnet.id,
        providerSubnetId: subnetProviderResourceId,
        ipRange: process.env.FLUI_SUBNET_IP_RANGE || '10.10.1.0/24',
        type: subnetType,
        networkZone: process.env.FLUI_SUBNET_NETWORK_ZONE || 'eu-central',
        attachedServerIds: [],
      });
      this.logger.log(`✅ Subnet seeded: ${subnet.id} (${subnet.ipRange})`);
    }

    return { vnetId: vnet.id, subnetId: subnet.id };
  }

  private async upsertVnet(opts: {
    vnetProviderResourceId: string;
    provider: CloudProvider;
    clusterId?: string;
    baseLabels: Array<{ key: string; value: string }>;
  }): Promise<VNetEntity> {
    const { vnetProviderResourceId, provider, clusterId, baseLabels } = opts;
    let vnet = await this.vnetRepo.findOne({
      where: { providerResourceId: vnetProviderResourceId, provider },
    });
    if (!vnet) {
      vnet = await this.vnetRepo.save({
        providerResourceId: vnetProviderResourceId,
        name:
          process.env.FLUI_VNET_NAME || `flui-env-${vnetProviderResourceId}`,
        provider,
        ipRange: process.env.FLUI_VNET_IP_RANGE || '10.10.0.0/16',
        labels: baseLabels,
        metadata: {
          source: 'bootstrap-seeder',
          ...(clusterId ? { clusterId } : {}),
        },
        status: VNetStatus.ACTIVE,
      });
      this.logger.log(`✅ VNet seeded: ${vnet.name} (${vnet.id})`);
      return vnet;
    }

    const labels = vnet.labels ?? [];
    const hasClusterLabel =
      clusterId &&
      labels.some((l) => l.key === 'flui-cluster-id' && l.value === clusterId);
    if (clusterId && !hasClusterLabel) {
      vnet.labels = [...labels, { key: 'flui-cluster-id', value: clusterId }];
      vnet.metadata = { ...vnet.metadata, clusterId };
      vnet = await this.vnetRepo.save(vnet);
      this.logger.log(
        `✅ VNet ${vnet.name} backfilled with flui-cluster-id label`,
      );
    } else {
      this.logger.debug('VNet already seeded');
    }
    return vnet;
  }

  private async seedCluster(
    vnetSeed: { vnetId: string; subnetId: string } | null,
  ): Promise<string | null> {
    const clusterId = process.env.CLUSTER_ID;
    // Use the public/reachable IP — it drives ACME, browser endpoints and the
    // OIDC issuer host; on BYOS the detected node IP is internal, so operator IP wins.
    const nodeIp = process.env.MASTER_IP;
    const masterIp = process.env.FLUI_MASTER_PUBLIC_IP || nodeIp;
    if (!clusterId || !masterIp) return null;

    const privateIp =
      process.env.FLUI_BOOTSTRAP_NODE_PRIVATE_IP ||
      (process.env.FLUI_MASTER_PUBLIC_IP ? nodeIp : undefined);
    const nipHostnameToken = process.env.NIP_HOSTNAME_TOKEN || undefined;
    const sharedStorageVolumeId =
      process.env.FLUI_SHARED_STORAGE_VOLUME_ID || undefined;
    const sharedStorageVolumeGbRaw =
      process.env.FLUI_SHARED_STORAGE_VOLUME_GB || '';
    const sharedStorageVolumeSizeGb = sharedStorageVolumeGbRaw
      ? Number.parseInt(sharedStorageVolumeGbRaw, 10) || undefined
      : undefined;
    const subnetId = vnetSeed?.subnetId ?? null;
    const vnetConfig = vnetSeed
      ? {
          vnetId: vnetSeed.vnetId,
          subnetId: vnetSeed.subnetId,
          autoAssignIp: true,
        }
      : null;

    const existingCluster = await this.clusterRepo.findOne({
      where: { id: clusterId },
    });
    if (existingCluster) {
      await this.backfillExistingCluster(existingCluster, {
        vnetConfig,
        privateIp,
        nipHostnameToken,
        sharedStorageVolumeId,
        sharedStorageVolumeSizeGb,
      });
      await this.seedKubeconfig(existingCluster);
      return clusterId;
    }

    const cluster = await this.clusterRepo.save({
      id: clusterId,
      name: process.env.CLUSTER_NAME || clusterId,
      provider: process.env.CLOUD_PROVIDER || CloudProvider.HETZNER,
      region: process.env.CLUSTER_REGION || '',
      nodeSize: process.env.INSTANCE_TYPE || '',
      nodeCount: 1,
      k3sTokenEncrypted: process.env.K3S_TOKEN
        ? this.encryptionService.encrypt(process.env.K3S_TOKEN)
        : '',
      k3sVersion: process.env.K3S_VERSION,
      masterIpAddress: masterIp,
      masterPrivateIp: privateIp,
      nipHostnameToken,
      sharedStorageEnabled: !!sharedStorageVolumeId,
      sharedStorageVolumeId: sharedStorageVolumeId ?? null,
      sharedStorageVolumeSizeGb: sharedStorageVolumeSizeGb ?? null,
      status: ClusterStatus.READY,
      clusterType: ClusterType.CONTROL,
      metadata: {
        source: 'bootstrap-seeder',
        ...(vnetConfig ? { vnetConfig } : {}),
      },
    });

    const nodeId = process.env.SERVER_ID;
    const instanceId = process.env.INSTANCE_ID || '';
    const instanceName = process.env.INSTANCE_NAME || `${cluster.name}-master`;

    const resolvedProviderResourceId = await this.resolveProviderResourceId(
      cluster.provider as CloudProvider,
      instanceId,
      instanceName,
    );

    if (nodeId) {
      await this.clusterNodeRepo.save({
        id: nodeId,
        clusterId,
        serverName: instanceName,
        providerResourceId: resolvedProviderResourceId,
        nodeType: NodeType.MASTER,
        ipAddress: masterIp,
        privateIp,
        subnetId: subnetId || undefined,
        status: NodeStatus.READY,
        metadata: { source: 'bootstrap-seeder' },
      });
      await this.billingIntervals.openNodeInterval({
        clusterId,
        nodeId,
        serverName: instanceName,
        providerResourceId: resolvedProviderResourceId,
        provider: cluster.provider,
        region: cluster.region,
        serverType: cluster.nodeSize,
        nodeType: NodeType.MASTER,
      });
    }
    if (sharedStorageVolumeId) {
      await this.billingIntervals.openVolumeInterval({
        clusterId,
        volumeProviderId: sharedStorageVolumeId,
        provider: cluster.provider,
        region: cluster.region,
        kind: VolumeBillableKind.SHARED_STORAGE,
        sizeGb: sharedStorageVolumeSizeGb ?? 0,
      });
    }

    if (subnetId && resolvedProviderResourceId) {
      await this.attachServerToSubnet(subnetId, resolvedProviderResourceId);
    }

    await this.seedKubeconfig(cluster);
    this.logger.log(`✅ Cluster seeded: ${cluster.name} (${clusterId})`);
    return clusterId;
  }

  private async backfillExistingCluster(
    existingCluster: ClusterEntity,
    opts: {
      vnetConfig: {
        vnetId: string;
        subnetId: string;
        autoAssignIp: boolean;
      } | null;
      privateIp?: string;
      nipHostnameToken?: string;
      sharedStorageVolumeId?: string;
      sharedStorageVolumeSizeGb?: number;
    },
  ): Promise<void> {
    const {
      vnetConfig,
      privateIp,
      nipHostnameToken,
      sharedStorageVolumeId,
      sharedStorageVolumeSizeGb,
    } = opts;
    let dirty = false;
    if (vnetConfig && !existingCluster.metadata?.vnetConfig?.vnetId) {
      existingCluster.metadata = {
        ...existingCluster.metadata,
        vnetConfig,
      };
      dirty = true;
      this.logger.log(
        `✅ Cluster ${existingCluster.name} backfilled with vnetConfig`,
      );
    }
    if (privateIp && !existingCluster.masterPrivateIp) {
      existingCluster.masterPrivateIp = privateIp;
      dirty = true;
      this.logger.log(
        `✅ Cluster ${existingCluster.name} backfilled with masterPrivateIp=${privateIp}`,
      );
    }
    if (nipHostnameToken && !existingCluster.nipHostnameToken) {
      existingCluster.nipHostnameToken = nipHostnameToken;
      dirty = true;
      this.logger.log(
        `✅ Cluster ${existingCluster.name} backfilled with nipHostnameToken=${nipHostnameToken}`,
      );
    }
    if (sharedStorageVolumeId && !existingCluster.sharedStorageVolumeId) {
      existingCluster.sharedStorageVolumeId = sharedStorageVolumeId;
      existingCluster.sharedStorageEnabled = true;
      if (sharedStorageVolumeSizeGb) {
        existingCluster.sharedStorageVolumeSizeGb = sharedStorageVolumeSizeGb;
      }
      dirty = true;
      this.logger.log(
        `✅ Cluster ${existingCluster.name} backfilled with sharedStorageVolumeId=${sharedStorageVolumeId} (${sharedStorageVolumeSizeGb ?? '?'} GB)`,
      );
      await this.billingIntervals.openVolumeInterval({
        clusterId: existingCluster.id,
        volumeProviderId: sharedStorageVolumeId,
        provider: existingCluster.provider,
        region: existingCluster.region,
        kind: VolumeBillableKind.SHARED_STORAGE,
        sizeGb: existingCluster.sharedStorageVolumeSizeGb ?? 0,
      });
    }
    if (dirty) {
      await this.clusterRepo.save(existingCluster);
    } else {
      this.logger.debug('Cluster already seeded');
    }
  }

  private async attachServerToSubnet(
    subnetId: string,
    providerResourceId: string,
  ): Promise<void> {
    const subnet = await this.vnetSubnetRepo.findOne({
      where: { id: subnetId },
    });
    if (!subnet) return;
    const attached = subnet.attachedServerIds || [];
    if (attached.includes(providerResourceId)) return;
    attached.push(providerResourceId);
    await this.vnetSubnetRepo.update(subnet.id, {
      attachedServerIds: attached,
    });
  }

  private async resolveProviderResourceId(
    provider: CloudProvider,
    instanceId: string,
    instanceName: string,
  ): Promise<string> {
    const seeder = this.findSeeder(provider);
    if (!seeder) return instanceId;
    return seeder.resolveProviderResourceId({
      instanceId,
      instanceName,
      env: process.env,
    });
  }

  /**
   * Encrypt and store kubeconfig from KUBECONFIG env var into the cluster entity.
   * Called both for new clusters and on subsequent restarts (idempotent).
   */
  private async seedKubeconfig(cluster: ClusterEntity): Promise<void> {
    // KUBECONFIG env var contains the kubeconfig file content (injected from flui-secrets)
    const kubeconfigContent = process.env.KUBECONFIG_CONTENT;
    if (!kubeconfigContent) return;

    if (cluster.kubeconfigEncrypted) {
      this.logger.debug('Kubeconfig already stored in cluster');
      return;
    }

    try {
      // k3s writes 127.0.0.1:6443 in the kubeconfig. Since the API pod runs
      // inside the same cluster, replace with the in-cluster K8s API service.
      const patchedKubeconfig = kubeconfigContent.replaceAll(
        /https?:\/\/127\.0\.0\.1:6443/g,
        'https://kubernetes.default.svc:443',
      );
      const encrypted = this.encryptionService.encrypt(patchedKubeconfig);
      await this.clusterRepo.update(cluster.id, {
        kubeconfigEncrypted: encrypted,
      });
      this.logger.log('✅ Kubeconfig stored in cluster');
    } catch (error) {
      this.logger.warn(`Kubeconfig seeding skipped: ${error.message}`);
    }
  }

  /**
   * Seed firewall record from CLUSTER_FIREWALL_ID env var.
   * Creates a minimal firewall entry linking the provider firewall to this cluster.
   */
  private async seedFirewall(clusterId: string): Promise<void> {
    const firewallId = process.env.CLUSTER_FIREWALL_ID;
    if (!firewallId) return;

    const existing = await this.firewallRepo.findOne({
      where: { id: firewallId },
    });
    if (existing) {
      this.logger.debug('Firewall already seeded');
      return;
    }

    const provider =
      (process.env.CLOUD_PROVIDER as CloudProvider) || CloudProvider.HETZNER;
    const clusterName = process.env.CLUSTER_NAME || clusterId;

    await this.firewallRepo.save({
      id: firewallId,
      name: `${clusterName}-firewall`,
      provider,
      clusterId,
      rules: [],
      sourceCidrs: [],
      appliedToServerIds: [],
      labels: { 'managed-by': 'flui-cloud', 'flui-cluster-id': clusterId },
      metadata: { source: 'bootstrap-seeder' },
    });
    this.logger.log(`✅ Firewall seeded: ${firewallId}`);
  }

  /**
   * Seed ClusterFirewallEntity (desired-state firewall) by fetching rules from
   * the cloud provider. This is what the dashboard uses — distinct from the
   * simpler FirewallEntity seeded above.
   */
  private async seedClusterFirewall(clusterId: string): Promise<void> {
    const firewallId = process.env.CLUSTER_FIREWALL_ID;
    if (!firewallId) return;

    const existing = await this.firewallDesiredState
      .listFirewalls({ clusterId })
      .then((list) => list[0] || null);

    if (existing) {
      this.logger.debug('ClusterFirewall already seeded');
      return;
    }

    const cloudProvider = (
      process.env.CLOUD_PROVIDER || ''
    ).toLowerCase() as CloudProvider;
    const firewallProvider =
      this.firewallProviderFactory.getFirewallProvider(cloudProvider);
    if (!firewallProvider) {
      this.logger.warn(
        `ClusterFirewall skipped: no firewall provider registered for ${cloudProvider}`,
      );
      return;
    }

    const providerFirewall = await firewallProvider.getFirewall(firewallId);
    if (!providerFirewall) {
      this.logger.warn(
        `ClusterFirewall skipped: firewall ${firewallId} not found on provider ${cloudProvider}`,
      );
      return;
    }

    const firewall = await this.firewallDesiredState.createFirewall(
      clusterId,
      providerFirewall.rules,
    );

    await this.firewallDesiredState.markReconciliationComplete(
      firewall.id,
      providerFirewall.rules,
      firewallId,
    );

    this.logger.log(`✅ ClusterFirewall seeded: ${firewall.id}`);
  }

  /**
   * Discover and register system apps for the cluster.
   * Reuses SystemAppCatalogService.discoverSystemApps() — same logic as the HTTP endpoint.
   * Requires kubeconfig to be present in the cluster entity.
   */
  private async seedSystemApps(clusterId: string): Promise<void> {
    try {
      const cluster = await this.clusterRepo.findOne({
        where: { id: clusterId },
      });
      if (!cluster?.kubeconfigEncrypted) {
        this.logger.debug('System apps discovery skipped: no kubeconfig yet');
        return;
      }

      const result =
        await this.systemAppCatalogService.discoverSystemApps(clusterId);

      if (result.discovered.length > 0) {
        this.logger.log(
          `✅ System apps discovered: ${result.discovered.map((a) => a.name).join(', ')}`,
        );
      }
      if (result.skipped.length > 0) {
        this.logger.debug(
          `System apps already registered: ${result.skipped.map((a) => a.name).join(', ')}`,
        );
      }
      if (result.errors.length > 0) {
        const errorsSummary = result.errors
          .map((e) => `${e.name}: ${e.error}`)
          .join(', ');
        this.logger.warn(`System apps discovery errors: ${errorsSummary}`);
      }
    } catch (error) {
      this.logger.warn(`System apps discovery skipped: ${error.message}`);
    }
  }
}
