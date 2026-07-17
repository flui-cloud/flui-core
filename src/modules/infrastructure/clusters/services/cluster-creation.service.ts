import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { CreateClusterDto } from '../dto/create-cluster.dto';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { ClusterFirewallIntegrationService } from './cluster-firewall-integration.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { sanitizeApiServerFirewallRules } from '../../firewalls/templates/firewall-rules.template';
import { FirewallReconciliationService } from '../../firewalls/services/firewall-reconciliation.service';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import {
  estimateCreateDurationSeconds,
  getOperationSteps,
} from '../../operations/helpers/operation-steps.helper';
import { CreateClusterJobData } from '../clusters.service';
import { VNetSubnetEntity } from '../../vnets/entities/vnet-subnet.entity';
import {
  generateNipHostnameToken,
  isValidNipHostnameToken,
} from '../../../dns/utils/nip-token.util';
import { HostnameMode } from '../../../dns/enums/hostname-mode.enum';

/**
 * Service responsible for cluster creation logic
 */
@Injectable()
export class ClusterCreationService {
  private readonly logger = new Logger(ClusterCreationService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(VNetSubnetEntity)
    private readonly vnetSubnetRepository: Repository<VNetSubnetEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly encryptionService: EncryptionService,
    private readonly clusterFirewallIntegrationService: ClusterFirewallIntegrationService,
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
    private readonly firewallReconciliation: FirewallReconciliationService,
  ) {}

  /**
   * Create a new K3s cluster
   */
  async createCluster(
    dto: CreateClusterDto,
  ): Promise<InfrastructureOperationEntity> {
    this.logger.log(`Creating cluster: ${dto.name}`);

    // Generate and encrypt K3s token
    const k3sToken = this.encryptionService.generateK3sToken();
    const k3sTokenEncrypted = this.encryptionService.encrypt(k3sToken);

    // Determine cluster type from metadata
    const metadata = dto.metadata || {};
    const clusterType =
      metadata.isControlCluster || metadata.isObservabilityCluster
        ? ClusterType.CONTROL
        : ClusterType.WORKLOAD;

    // Resolve the environment-level VNet/Subnet (seeded at bootstrap by the CLI).
    // Same-provider clusters join this shared private network so intra- and
    // inter-cluster traffic stays off the public interface. A cross-provider
    // workload can't attach to it (the network lives on the control's provider),
    // so it must bring its own VNet on its own provider — cross-provider
    // reachability is handled by firewall peer rules, not a shared L2.
    const envSubnet = await this.vnetSubnetRepository.findOne({
      where: {},
      order: { createdAt: 'ASC' },
      relations: ['vnet'],
    });
    if (!envSubnet) {
      throw new BadRequestException(
        'No environment subnet registered. The CLI must provision a VNet/Subnet during `flui env create` before any cluster can be created.',
      );
    }

    const isCrossProvider = envSubnet.vnet?.provider !== dto.provider;
    let hasUsableSubnet: boolean;
    if (isCrossProvider) {
      if (dto.vnetConfig) {
        metadata.vnetConfig = {
          vnetId: dto.vnetConfig.vnetId,
          subnetId: dto.vnetConfig.subnetId,
          autoAssignIp: dto.vnetConfig.autoAssignIp ?? true,
        };
        this.logger.log(
          `Cross-provider cluster ${dto.name} (${dto.provider}) attached to its own VNet ${dto.vnetConfig.vnetId}`,
        );
      } else {
        this.logger.log(
          `Cross-provider cluster ${dto.name} (${dto.provider}) has no VNet supplied; deferring to provider policy`,
        );
      }
      hasUsableSubnet = !!dto.vnetConfig;
    } else {
      metadata.vnetConfig = {
        vnetId: envSubnet.vnetId,
        subnetId: envSubnet.id,
        autoAssignIp: true,
      };
      this.logger.log(
        `Cluster ${dto.name} attached to environment subnet ${envSubnet.id} (${envSubnet.ipRange})`,
      );
      hasUsableSubnet = true;
    }

    await this.enforceProviderPolicies(dto, clusterType, hasUsableSubnet);

    // Resolve nip.io hostname token: when running in IP mode, every cluster gets
    // a unique token segment so the LE domain set differs between recreations,
    // avoiding the 5-certs-per-7-days rate limit.
    const hostnameMode = dto.endpointHostnameMode ?? HostnameMode.IP;
    let nipHostnameToken: string | null = null;
    if (hostnameMode === HostnameMode.IP) {
      if (dto.nipHostnameToken) {
        if (!isValidNipHostnameToken(dto.nipHostnameToken)) {
          throw new BadRequestException(
            'nipHostnameToken must match [a-z0-9-], 1-30 chars, no leading/trailing dash.',
          );
        }
        nipHostnameToken = dto.nipHostnameToken;
      } else {
        nipHostnameToken = generateNipHostnameToken();
      }
      this.logger.log(
        `Cluster ${dto.name} nip.io hostname token: ${nipHostnameToken}`,
      );
    }

    // Create cluster record
    const cluster = this.clusterRepository.create({
      name: dto.name,
      provider: dto.provider,
      region: dto.region,
      nodeSize: dto.nodeSize,
      nodeCount: 0, // Will be updated as nodes are created
      autoscalingEnabled: dto.autoscalingEnabled || false,
      minNodes: dto.minNodes,
      maxNodes: dto.maxNodes,
      scaleUpMemoryPct: dto.scaleUpMemoryPct,
      scaleUpCpuPct: dto.scaleUpCpuPct,
      cooldownSeconds: dto.cooldownSeconds,
      k3sTokenEncrypted,
      k3sVersion: dto.k3sVersion,
      status: ClusterStatus.CREATING,
      clusterType,
      sshKeyIds: dto.sshKeys,
      image: dto.image,
      diskSizeGb: dto.diskSizeGb,
      endpointHostnameMode: dto.endpointHostnameMode,
      nipHostnameToken,
      // Flui shared storage (§14 of scaling doc). Default enabled for all
      // cluster types unless explicitly disabled via --no-shared-storage.
      // The architecture works on both OBSERVABILITY and WORKLOAD clusters;
      // the cluster-type discriminator is only for the future split where
      // observability gets its own dedicated topology.
      sharedStorageEnabled: dto.sharedStorageEnabled !== false,
      sharedStorageVolumeSizeGb: dto.sharedStorageVolumeSizeGb ?? 20,
      metadata,
    });

    const savedCluster = await this.clusterRepository.save(cluster);
    this.logger.log(`Cluster record created: ${savedCluster.id}`);

    // Create cluster firewall (BEFORE creating nodes).
    // Intra-cluster Prometheus scraping no longer requires public firewall rules:
    // observability ↔ workload metrics traffic flows over the environment VNet.
    let providerFirewallId: string | null = null;
    try {
      const desiredRules = await this.buildDesiredFirewallRules(
        dto.firewallRules || [],
        envSubnet.ipRange,
        clusterType,
      );

      providerFirewallId =
        await this.clusterFirewallIntegrationService.createAndReconcileFirewall(
          savedCluster,
          desiredRules,
        );
      this.logger.log(
        `Firewall created for cluster ${savedCluster.id}: ${providerFirewallId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to create firewall for cluster ${savedCluster.id}: ${error.message}`,
        error.stack,
      );
      // Firewall creation failure should fail cluster creation
      await this.clusterRepository.delete(savedCluster.id);
      throw new BadRequestException(
        `Failed to create cluster firewall: ${error.message}`,
      );
    }

    // Use worker count directly from DTO
    const workerCount = dto.workerCount;

    // Generate dynamic steps based on cluster configuration
    const withFirewall = !!providerFirewallId;
    const operationSteps = getOperationSteps(OperationType.CREATE_CLUSTER, {
      workerCount,
      withFirewall,
    });

    // Create operation for tracking
    const operation = this.operationRepository.create({
      operationType: OperationType.CREATE_CLUSTER,
      status: OperationStatus.PENDING,
      resourceType: 'cluster',
      resourceName: dto.name,
      resourceId: savedCluster.id,
      provider: dto.provider,
      totalSteps: operationSteps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        clusterConfig: dto,
        estimatedDurationInSeconds: estimateCreateDurationSeconds(workerCount),
        providerFirewallId, // Single firewall ID (not array)
        operationSteps: operationSteps, // Fixed: was 'steps', now 'operationSteps'
      },
    });

    const savedOperation = await this.operationRepository.save(operation);

    // Queue cluster creation job
    const jobData: CreateClusterJobData = {
      operationId: savedOperation.id,
      clusterId: savedCluster.id,
    };

    await this.infrastructureQueue.add('create-cluster', jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      timeout: 1800000, // 30 minutes
    });

    this.logger.log(
      `Cluster creation job queued for cluster ${savedCluster.id} with operation ${savedOperation.id}`,
    );

    return savedOperation;
  }

  /**
   * Resolve the firewall rules to seed at cluster creation. An empty input is an
   * explicit deny-all firewall (documented DTO behaviour) and is passed through
   * untouched; when rules are supplied we sanitize the API-server rule and then
   * enforce the 80/443, workload-SSH and dual-stack invariants so the same
   * server-side guarantees hold at create time as on every later update.
   */
  private async buildDesiredFirewallRules(
    providedRules: FirewallRuleDto[],
    subnetCidr: string,
    clusterType: ClusterType,
  ): Promise<FirewallRuleDto[]> {
    if (providedRules.length === 0) return providedRules;
    // Resolved here rather than left to the 5-minute peer reconciler: the master
    // is SSHed into within seconds of this firewall being applied.
    const controlIps =
      await this.firewallReconciliation.resolveControlEgressIps();
    return FirewallReconciliationService.ensureDualStackWildcards(
      FirewallReconciliationService.ensureWorkloadSshFromControl(
        clusterType,
        FirewallReconciliationService.ensureRequiredIngress(
          sanitizeApiServerFirewallRules(providedRules, subnetCidr),
        ),
        controlIps,
      ),
    );
  }

  private async enforceProviderPolicies(
    dto: CreateClusterDto,
    clusterType: ClusterType,
    hasUsableSubnet: boolean,
  ): Promise<void> {
    // Policy first: when cross-provider is banned outright, VNET_REQUIRED would
    // send the user off to create a VNet only to hit the real block afterwards.
    await this.assertWorkloadProviderMatchesControl(dto, clusterType);

    const capabilities = this.capabilitiesFactory
      .getCapabilitiesService(dto.provider)
      .getStaticCapabilities();

    if (capabilities.vnetRequired && !dto.vnetConfig && !hasUsableSubnet) {
      throw new BadRequestException({
        code: 'VNET_REQUIRED',
        message: `Provider '${dto.provider}' requires a VNet/Subnet, but none was supplied or registered.`,
        details: { provider: dto.provider },
      });
    }
  }

  private async assertWorkloadProviderMatchesControl(
    dto: CreateClusterDto,
    clusterType: ClusterType,
  ): Promise<void> {
    if (clusterType !== ClusterType.WORKLOAD) {
      return;
    }

    const control = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!control || control.provider === dto.provider) {
      return;
    }

    // Cross-provider is gated by the CONTROL provider's capability: a control
    // that permits it (e.g. BYOS, which can't provision workloads on itself)
    // may run workloads on other providers.
    const controlAllowsCross = this.capabilitiesFactory
      .getCapabilitiesService(control.provider as CloudProvider)
      .getStaticCapabilities().crossClusterAllowed;
    if (controlAllowsCross) {
      return;
    }

    throw new BadRequestException({
      code: 'CROSS_PROVIDER_NOT_ALLOWED',
      message: `Workload provider '${dto.provider}' must match the control cluster provider '${control.provider}'.`,
      details: {
        workloadProvider: dto.provider,
        controlProvider: control.provider,
      },
    });
  }
}
