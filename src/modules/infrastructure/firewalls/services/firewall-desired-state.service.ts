import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import {
  ClusterFirewallEntity,
  ReconciliationStatus,
} from '../entities/cluster-firewall.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import {
  FirewallResponseDto,
  FirewallClusterInfoDto,
  FirewallNodeInfoDto,
  FirewallCoverageStatus,
  ListFirewallsQueryDto,
  ReconciliationStatusDto,
} from '../dto/cluster-firewall.dto';
import { ClusterStatus } from '../../clusters/entities/cluster.entity';
import { NodeStatus } from '../../clusters/entities/cluster-node.entity';

@Injectable()
export class FirewallDesiredStateService {
  private readonly logger = new Logger(FirewallDesiredStateService.name);

  constructor(
    @InjectRepository(ClusterFirewallEntity)
    private readonly firewallRepository: Repository<ClusterFirewallEntity>,
  ) {}

  /**
   * Create a new firewall for a cluster
   */
  async createFirewall(
    clusterId: string,
    desiredRules: FirewallRuleDto[],
  ): Promise<ClusterFirewallEntity> {
    this.logger.log(`Creating firewall for cluster ${clusterId}`);

    // Check if firewall already exists for this cluster
    const existing = await this.firewallRepository.findOne({
      where: { clusterId },
    });

    if (existing) {
      throw new ConflictException(
        `Firewall already exists for cluster ${clusterId}`,
      );
    }

    const canonicalRules = this.canonicalizeRules(desiredRules);
    const desiredHash = this.calculateHash(canonicalRules);

    const firewall = this.firewallRepository.create({
      clusterId,
      desiredRules: canonicalRules,
      desiredHash,
      reconciliationStatus: ReconciliationStatus.PENDING,
    });

    return await this.firewallRepository.save(firewall);
  }

  /**
   * Get firewall by ID
   */
  async getFirewallById(id: string): Promise<ClusterFirewallEntity> {
    const firewall = await this.firewallRepository.findOne({
      where: { id },
      relations: ['cluster', 'cluster.nodes'],
    });

    if (!firewall) {
      throw new NotFoundException(`Firewall with ID ${id} not found`);
    }

    return firewall;
  }

  /**
   * Get firewall by cluster ID
   */
  async getFirewallByClusterId(
    clusterId: string,
  ): Promise<ClusterFirewallEntity> {
    const firewall = await this.firewallRepository.findOne({
      where: { clusterId },
      relations: ['cluster', 'cluster.nodes'],
    });

    if (!firewall) {
      throw new NotFoundException(
        `Firewall for cluster ${clusterId} not found`,
      );
    }

    return firewall;
  }

  /**
   * List all firewalls with optional filters
   */
  async listFirewalls(
    filters?: ListFirewallsQueryDto,
  ): Promise<ClusterFirewallEntity[]> {
    const queryBuilder = this.firewallRepository
      .createQueryBuilder('firewall')
      .leftJoinAndSelect('firewall.cluster', 'cluster')
      .leftJoinAndSelect('cluster.nodes', 'nodes');

    if (filters?.clusterId) {
      queryBuilder.andWhere('firewall.clusterId = :clusterId', {
        clusterId: filters.clusterId,
      });
    }

    if (filters?.status) {
      queryBuilder.andWhere('firewall.reconciliationStatus = :status', {
        status: filters.status,
      });
    }

    return await queryBuilder.getMany();
  }

  /**
   * Set desired rules for a firewall
   */
  async setDesiredRules(
    firewallId: string,
    desiredRules: FirewallRuleDto[],
  ): Promise<ClusterFirewallEntity> {
    const firewall = await this.getFirewallById(firewallId);

    const canonicalRules = this.canonicalizeRules(desiredRules);
    const newDesiredHash = this.calculateHash(canonicalRules);

    // If hash matches, no change needed
    if (newDesiredHash === firewall.desiredHash) {
      this.logger.log(`No changes to desired rules for firewall ${firewallId}`);
      return firewall;
    }

    firewall.desiredRules = canonicalRules;
    firewall.desiredHash = newDesiredHash;

    // If hash doesn't match last applied, mark as drift
    if (newDesiredHash !== firewall.lastAppliedHash) {
      firewall.reconciliationStatus = ReconciliationStatus.DRIFT;
      this.logger.log(`Firewall ${firewallId} marked as DRIFT`);
    }

    return await this.firewallRepository.save(firewall);
  }

  /**
   * Update firewall reconciliation status
   */
  async updateReconciliationStatus(
    firewallId: string,
    status: ReconciliationStatus,
    errorMessage?: string,
  ): Promise<ClusterFirewallEntity> {
    const firewall = await this.getFirewallById(firewallId);

    firewall.reconciliationStatus = status;
    firewall.errorMessage = errorMessage || null;

    if (
      status === ReconciliationStatus.IN_SYNC ||
      status === ReconciliationStatus.ERROR
    ) {
      firewall.lastReconciliationAt = new Date();
    }

    return await this.firewallRepository.save(firewall);
  }

  /**
   * Mark reconciliation complete and update applied state
   */
  async markReconciliationComplete(
    firewallId: string,
    appliedRules: FirewallRuleDto[],
    providerFirewallId?: string,
  ): Promise<ClusterFirewallEntity> {
    const firewall = await this.getFirewallById(firewallId);

    const canonicalAppliedRules = this.canonicalizeRules(appliedRules);
    const appliedHash = this.calculateHash(canonicalAppliedRules);

    firewall.lastAppliedRules = canonicalAppliedRules;
    firewall.lastAppliedHash = appliedHash;
    firewall.lastReconciliationAt = new Date();
    firewall.errorMessage = null;

    if (providerFirewallId) {
      firewall.providerFirewallId = providerFirewallId;
    }

    // Determine status based on hash comparison
    if (appliedHash === firewall.desiredHash) {
      firewall.reconciliationStatus = ReconciliationStatus.IN_SYNC;
    } else {
      firewall.reconciliationStatus = ReconciliationStatus.DRIFT;
    }

    return await this.firewallRepository.save(firewall);
  }

  /**
   * Update both desired and applied state atomically after successful provider update
   * Used by updateAndApplyRules flow
   */
  async updateDesiredAndAppliedState(
    firewall: ClusterFirewallEntity,
    rules: FirewallRuleDto[],
    providerFirewallId?: string,
  ): Promise<ClusterFirewallEntity> {
    const canonicalRules = this.canonicalizeRules(rules);
    const hash = this.calculateHash(canonicalRules);

    firewall.desiredRules = canonicalRules;
    firewall.desiredHash = hash;
    firewall.lastAppliedRules = canonicalRules;
    firewall.lastAppliedHash = hash;
    firewall.lastReconciliationAt = new Date();
    firewall.reconciliationStatus = ReconciliationStatus.IN_SYNC;
    firewall.errorMessage = null;

    if (providerFirewallId) {
      firewall.providerFirewallId = providerFirewallId;
    }

    return await this.firewallRepository.save(firewall);
  }

  /**
   * Detect drift between desired and last applied state
   */
  async detectDrift(firewallId: string): Promise<boolean> {
    const firewall = await this.getFirewallById(firewallId);

    if (!firewall.lastAppliedHash) {
      return true; // Never reconciled
    }

    return firewall.desiredHash !== firewall.lastAppliedHash;
  }

  /**
   * Get reconciliation status
   */
  async getReconciliationStatus(
    firewallId: string,
  ): Promise<ReconciliationStatusDto> {
    const firewall = await this.getFirewallById(firewallId);
    const hasDrift = await this.detectDrift(firewallId);

    return {
      status: firewall.reconciliationStatus,
      hasDrift,
      lastReconciliationAt: firewall.lastReconciliationAt,
      errorMessage: firewall.errorMessage,
      desiredHash: firewall.desiredHash,
      lastAppliedHash: firewall.lastAppliedHash,
    };
  }

  /**
   * Delete a firewall
   */
  async deleteFirewall(firewallId: string): Promise<void> {
    const firewall = await this.getFirewallById(firewallId);
    await this.firewallRepository.remove(firewall);
    this.logger.log(`Deleted firewall ${firewallId}`);
  }

  /**
   * Calculate canonical hash of rules
   */
  /**
   * Records what the provider was last given, beside the rules rather than
   * inside their hash.
   *
   * `desiredHash` answers "are these the rules we want" and is compared against
   * the applied hash to report drift; a value that moved for any other reason
   * would report drift against rules that are in fact correct.
   */
  async rememberPayloadFingerprint(
    firewallId: string,
    fingerprint: string,
  ): Promise<void> {
    const firewall = await this.getFirewallById(firewallId);
    firewall.metadata = {
      ...(firewall.metadata ?? {}),
      payloadFingerprint: fingerprint,
    };
    await this.firewallRepository.save(firewall);
  }

  calculateHash(rules: FirewallRuleDto[]): string {
    const canonical = this.canonicalizeRules(rules);
    const json = JSON.stringify(canonical);
    return createHash('sha256').update(json).digest('hex');
  }

  /**
   * Canonicalize rules for consistent hashing and comparison
   * - Sorts rules by direction, protocol, port, description
   * - Sorts source/destination IPs
   * - Normalizes protocol to lowercase
   */
  canonicalizeRules(rules: FirewallRuleDto[]): FirewallRuleDto[] {
    if (!rules || rules.length === 0) {
      return [];
    }

    return rules
      .map((rule) => ({
        description: rule.description || '',
        direction: rule.direction,
        protocol: rule.protocol.toLowerCase() as 'tcp' | 'udp' | 'icmp',
        port: rule.port || null,
        sourceIps: rule.sourceIps
          ? [...rule.sourceIps].sort((a, b) => a.localeCompare(b))
          : undefined,
        destinationIps: rule.destinationIps
          ? [...rule.destinationIps].sort((a, b) => a.localeCompare(b))
          : undefined,
      }))
      .sort((a, b) => {
        // Sort by: direction, protocol, port, description
        if (a.direction !== b.direction) {
          return a.direction.localeCompare(b.direction);
        }
        if (a.protocol !== b.protocol) {
          return a.protocol.localeCompare(b.protocol);
        }
        const portA = a.port || '';
        const portB = b.port || '';
        if (portA !== portB) {
          return portA.localeCompare(portB);
        }
        return a.description.localeCompare(b.description);
      });
  }

  /**
   * Convert entity to DTO
   */
  toResponseDto(firewall: ClusterFirewallEntity): FirewallResponseDto {
    const hasDrift = firewall.desiredHash !== firewall.lastAppliedHash;
    const { coverageStatus, clusterInfo } = this.computeCoverage(firewall);

    return new FirewallResponseDto({
      id: firewall.id,
      clusterId: firewall.clusterId,
      providerFirewallId: firewall.providerFirewallId,
      desiredRules: firewall.desiredRules,
      lastAppliedRules: firewall.lastAppliedRules,
      desiredHash: firewall.desiredHash,
      lastAppliedHash: firewall.lastAppliedHash,
      reconciliationStatus: firewall.reconciliationStatus,
      hasDrift,
      coverageStatus,
      clusterInfo,
      lastReconciliationAt: firewall.lastReconciliationAt,
      errorMessage: firewall.errorMessage,
      metadata: firewall.metadata,
      createdAt: firewall.createdAt,
      updatedAt: firewall.updatedAt,
    });
  }

  /**
   * Compute firewall coverage status from cluster node state (no provider calls)
   */
  private computeCoverage(firewall: ClusterFirewallEntity): {
    coverageStatus: FirewallCoverageStatus;
    clusterInfo?: FirewallClusterInfoDto;
  } {
    const cluster = firewall.cluster;

    if (!cluster) {
      return { coverageStatus: FirewallCoverageStatus.UNKNOWN };
    }

    const orphanedClusterStatuses: ClusterStatus[] = [
      ClusterStatus.DELETED,
      ClusterStatus.DELETING,
    ];

    const nodes = cluster.nodes || [];
    const totalNodes = nodes.length;
    const readyNodes = nodes.filter(
      (n) => n.status === NodeStatus.READY,
    ).length;

    const nodeInfos: FirewallNodeInfoDto[] = nodes.map((n) => ({
      nodeId: n.id,
      serverName: n.serverName,
      nodeType: n.nodeType,
      status: n.status,
      ipAddress: n.ipAddress,
    }));

    const clusterInfo: FirewallClusterInfoDto = {
      clusterName: cluster.name,
      clusterStatus: cluster.status,
      totalNodes,
      readyNodes,
      nodes: nodeInfos,
    };

    let coverageStatus: FirewallCoverageStatus;

    if (orphanedClusterStatuses.includes(cluster.status)) {
      coverageStatus = FirewallCoverageStatus.ORPHANED;
    } else if (totalNodes === 0) {
      coverageStatus = FirewallCoverageStatus.ORPHANED;
    } else if (readyNodes === totalNodes) {
      coverageStatus = FirewallCoverageStatus.FULL;
    } else {
      coverageStatus = FirewallCoverageStatus.PARTIAL;
    }

    return { coverageStatus, clusterInfo };
  }
}
