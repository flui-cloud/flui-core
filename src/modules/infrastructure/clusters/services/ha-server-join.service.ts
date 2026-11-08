import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../entities/cluster-node.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { NativeSSHConnectionService } from '../../../terminal/services/native-ssh-connection.service';
import { ClusterOrchestrationService } from './cluster-orchestration.service';
import { HaCreationPlan, PlannedServer } from '../utils/ha-creation-plan.core';
import {
  JOIN_DETAILS_ALREADY_JOINED,
  JOIN_DETAILS_HANDED_OVER,
  JoinDetails,
  joinDetailsScript,
} from '../utils/join-details.util';

const HAND_OVER_ATTEMPTS = 30;
const HAND_OVER_INTERVAL_MS = 10_000;
const PLATFORM_INSTALL_TIMEOUT_MS = 20 * 60_000;
const PLATFORM_INSTALL_POLL_MS = 15_000;

// cloud-init done or in error with no marker: the boot script ended before the end.
const PLATFORM_INSTALL_STATE = [
  'if test -f /var/log/flui-bootstrap-complete; then echo platform-installed',
  "elif cloud-init status 2>/dev/null | grep -q -E 'status: (done|error)'; then echo platform-stopped",
  'else echo platform-installing; fi',
].join('; ');

function platformInstallState(
  out: string | undefined,
): 'installed' | 'stopped' | 'installing' {
  if (out?.includes('platform-installed')) return 'installed';
  if (out?.includes('platform-stopped')) return 'stopped';
  return 'installing';
}

export interface HaPurchase {
  zone: string;
  node?: ClusterNodeEntity;
  error?: string;
}

export interface HaJoined {
  joined: number;
  joinedAt: string;
  missing: string[];
  joinedMessage: string;
  readyMessage: string;
}

/** Throws when the creation must stop; checked between servers and while waiting. */
export type StopCheck = () => Promise<void>;

const keepGoing: StopCheck = async () => undefined;

/** Writes a step of the creation's operation; the job owns the operation. */
export type OperationStepWriter = (
  step: number,
  progress: number,
  data: Record<string, unknown>,
) => Promise<void>;

/** What the creation says once the servers joined, or did not. */
export function haJoinOutcome(
  plan: HaCreationPlan,
  joinedZones: Array<string | null | undefined>,
  missing: string[],
): Pick<HaJoined, 'joinedMessage' | 'readyMessage'> {
  const where = [plan.first.zone, ...joinedZones];
  return {
    joinedMessage: joinedZones.length
      ? `Joined the servers in ${joinedZones.join(' and ')}`
      : 'No other server joined',
    readyMessage: missing.length
      ? `Cluster ready in ${where.join(', ')}; a server is still missing in ${missing.join(' and ')}: add it from the High availability tab`
      : `Cluster ready across ${where.join(', ')}`,
  };
}

/**
 * The servers of a cluster across three locations: bought with its first
 * server, then told where to join one at a time, because etcd takes a single
 * new member at a time and K3s gives up instead of waiting when a second one
 * asks.
 */
@Injectable()
export class HaServerJoinService {
  private readonly logger = new Logger(HaServerJoinService.name);

  constructor(
    private readonly orchestration: ClusterOrchestrationService,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly nativeSsh: NativeSSHConnectionService,
  ) {}

  /**
   * Starts buying the other servers while the caller buys the first one.
   * Returned unawaited, so the purchases run alongside the first server's own.
   */
  async startBuying(
    cluster: ClusterEntity,
    plan: HaCreationPlan | undefined,
    operationId: string,
    providerFirewallIds: string[],
  ): Promise<{ purchases: Promise<HaPurchase[]> } | null> {
    if (!plan) return null;
    await this.orchestration.prepareBootstrapKey(cluster);
    const purchases = this.buyServersToJoinLater(
      cluster,
      plan.servers,
      operationId,
      providerFirewallIds,
    ).catch((err) =>
      plan.servers.map((s) => ({
        zone: s.zone,
        error: err instanceof Error ? err.message : String(err),
      })),
    );
    return { purchases };
  }

  /** Joins what was bought, in the planned order, and says what is still missing. */
  async joinBought(
    cluster: ClusterEntity,
    plan: HaCreationPlan,
    bought: { purchases: Promise<HaPurchase[]> },
    operationId: string,
    step: OperationStepWriter,
    stop: StopCheck = keepGoing,
  ): Promise<HaJoined> {
    const purchases = await bought.purchases;
    const notBought = purchases.filter((p) => p.error);
    for (const p of notBought) {
      this.logger.warn(
        `[ha] ${cluster.name}: the server in ${p.zone} was not bought: ${p.error}`,
      );
    }
    await step(3, 10, {
      message: `Joining the servers in ${plan.servers.map((s) => s.zone).join(' and ')}, one at a time`,
    });
    const { joined, failed } = await this.joinWaitingServers(
      cluster,
      operationId,
      stop,
    );
    for (const f of failed) {
      this.logger.warn(
        `[ha] ${cluster.name}: ${f.name} did not join: ${f.error}`,
      );
    }
    const missing = [
      ...plan.later,
      ...notBought.map((p) => p.zone),
      ...failed.map((f) => f.zone ?? f.name),
    ];
    return {
      joined: joined.length,
      joinedAt: new Date().toISOString(),
      missing,
      ...haJoinOutcome(
        plan,
        joined.map((n) => n.region),
        missing,
      ),
    };
  }

  /**
   * When Flui finished installing on the first server, or why it did not:
   * the cluster exists either way, so this is said, not undone.
   */
  async waitForPlatform(
    cluster: ClusterEntity,
    step: OperationStepWriter,
    stepIndex = 4,
    stop: StopCheck = keepGoing,
  ): Promise<{ at: string | null; problem: string | null }> {
    await step(stepIndex, 20, {
      message: 'Waiting for Flui to finish installing on the first server',
    });
    const state = await this.waitForPlatformInstalled(
      cluster,
      PLATFORM_INSTALL_TIMEOUT_MS,
      stop,
    );
    if (state === 'installed') {
      return { at: new Date().toISOString(), problem: null };
    }
    const problem =
      state === 'stopped'
        ? 'The install on the first server stopped before the end (its log is /var/log/k3s-master-init.log)'
        : 'Flui had not finished installing on the first server in time';
    this.logger.warn(`[ha] ${cluster.name}: ${problem}`);
    return { at: null, problem };
  }

  /**
   * Buys the other servers while the first one is still being made. Each
   * prepares itself and waits; none joins until `joinWaitingServers` tells it
   * where. A retried creation reuses the machine it already bought for a
   * location.
   */
  async buyServersToJoinLater(
    cluster: ClusterEntity,
    servers: PlannedServer[],
    operationId: string,
    providerFirewallIds: string[],
  ): Promise<HaPurchase[]> {
    const bought = await this.nodeRepository.find({
      where: { clusterId: cluster.id, nodeType: NodeType.WORKER },
    });
    let next = await this.orchestration.nextWorkerIndex(cluster);
    const indexes = servers.map(
      (s) =>
        bought.find((n) => n.metadata?.joinLater && n.region === s.zone)
          ?.metadata?.workerIndex ?? next++,
    );
    const settled = await Promise.allSettled(
      servers.map((s, i) =>
        this.orchestration.buyWorkerToJoinLater(
          cluster,
          indexes[i],
          s,
          operationId,
          providerFirewallIds,
        ),
      ),
    );
    return settled.map((result, i) =>
      result.status === 'fulfilled'
        ? { zone: servers[i].zone, node: result.value }
        : {
            zone: servers[i].zone,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          },
    );
  }

  /** Joins the servers bought to join later, one at a time and in the order they were planned. */
  async joinWaitingServers(
    cluster: ClusterEntity,
    operationId: string,
    stop: StopCheck = keepGoing,
  ): Promise<{
    joined: ClusterNodeEntity[];
    failed: Array<{ name: string; zone: string | null; error: string }>;
  }> {
    const masterIp = cluster.masterPrivateIp || cluster.masterIpAddress;
    if (!masterIp) throw new Error('Master IP address not set');
    const details: JoinDetails = {
      masterIp,
      k3sToken: this.encryptionService.decrypt(cluster.k3sTokenEncrypted),
      sharedStorageMasterIp:
        cluster.sharedStorageEnabled === false ? null : cluster.masterPrivateIp,
    };
    const privateKey = await this.orchestration.bootstrapPrivateKey(cluster);
    const waiting = (
      await this.nodeRepository.find({
        where: { clusterId: cluster.id, nodeType: NodeType.WORKER },
      })
    )
      .filter((n) => n.metadata?.joinLater && n.providerResourceId)
      .filter((n) => n.status !== NodeStatus.READY)
      .sort(
        (a, b) =>
          (a.metadata?.workerIndex ?? 0) - (b.metadata?.workerIndex ?? 0),
      );

    const joined: ClusterNodeEntity[] = [];
    const failed: Array<{ name: string; zone: string | null; error: string }> =
      [];
    for (const node of waiting) {
      await stop();
      try {
        await this.handOverJoinDetails(cluster, node, privateKey, details);
        joined.push(
          await this.orchestration.awaitServerJoin(cluster, node, operationId),
        );
      } catch (err) {
        failed.push({
          name: node.serverName,
          zone: node.region ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { joined, failed };
  }

  /**
   * Waits for the first server's boot script to finish installing what Flui
   * runs on the cluster, which it marks after K3s itself has long been ready.
   * `stopped` when the script ended without marking it: waiting longer would
   * change nothing.
   */
  async waitForPlatformInstalled(
    cluster: ClusterEntity,
    timeoutMs = PLATFORM_INSTALL_TIMEOUT_MS,
    stop: StopCheck = keepGoing,
  ): Promise<'installed' | 'stopped' | 'timeout'> {
    const master = cluster.masterNodeId
      ? await this.nodeRepository.findOne({
          where: { id: cluster.masterNodeId },
        })
      : null;
    const host = master
      ? this.orchestration.nodeSshHost(cluster, master)
      : null;
    if (!host) return 'timeout';
    const privateKey = await this.orchestration.bootstrapPrivateKey(cluster);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await stop();
      try {
        const out = await this.nativeSsh.execCommand(
          host,
          'root',
          privateKey,
          PLATFORM_INSTALL_STATE,
          15000,
        );
        const state = platformInstallState(out);
        if (state !== 'installing') return state;
      } catch (err) {
        this.logger.warn(
          `Could not read ${cluster.name}'s install state yet: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await this.sleep(PLATFORM_INSTALL_POLL_MS);
    }
    return 'timeout';
  }

  private async handOverJoinDetails(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
    bootstrapPrivateKey: string,
    details: JoinDetails,
  ): Promise<void> {
    const host = this.orchestration.nodeSshHost(cluster, node);
    if (!host) throw new Error(`${node.serverName} has no address to reach`);
    const script = joinDetailsScript(details);
    let lastError = '';
    for (let attempt = 1; attempt <= HAND_OVER_ATTEMPTS; attempt++) {
      try {
        const out = await this.nativeSsh.execCommand(
          host,
          'root',
          bootstrapPrivateKey,
          script,
          20000,
        );
        if (
          out?.includes(JOIN_DETAILS_HANDED_OVER) ||
          out?.includes(JOIN_DETAILS_ALREADY_JOINED)
        ) {
          return;
        }
        lastError = 'the server did not confirm';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await this.sleep(HAND_OVER_INTERVAL_MS);
    }
    throw new Error(
      `Could not tell ${node.serverName} where to join: ${lastError}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
