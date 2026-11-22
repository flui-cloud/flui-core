import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ClusterNatsEntity } from '../entities/cluster-nats.entity';
import { NatsAccountEntity } from '../entities/nats-account.entity';
import {
  ClusterNatsSettings,
  NATS_NAMESPACE,
  buildNatsConfigMap,
  buildNatsService,
  buildNatsStatefulSet,
  natsConfig,
} from '../nats/cluster-nats.manifest';
import { buildKedaHelmChart } from '../keda/keda.manifest';
import {
  accountJwt,
  newAccountKey,
  newOperatorKey,
  operatorJwt,
  seedOf,
} from '../nats/nats-jwt';

export const NATS_ACCOUNTS_PATH = '/api/v1/messaging/nats/accounts/';

/** The address the cluster's NATS asks for accounts: the API's public one. */
export function natsResolverUrl(env: NodeJS.ProcessEnv = process.env): string {
  let base =
    env.PUBLIC_API_URL || env.FLUI_API_ENDPOINT || env.API_BASE_URL || '';
  while (base.endsWith('/')) base = base.slice(0, -1);
  if (!base) {
    throw new Error(
      'The Flui API address is not known (PUBLIC_API_URL / API_BASE_URL): a cluster’s NATS would have nobody to ask for its accounts.',
    );
  }
  return base.endsWith('/api/v1')
    ? `${base}/messaging/nats/accounts/`
    : `${base}${NATS_ACCOUNTS_PATH}`;
}

/**
 * The NATS every application of a cluster shares, each in an account of its
 * own. Keeps the operator of the cluster and puts the server on it.
 */
@Injectable()
export class ClusterNatsService {
  private readonly logger = new Logger(ClusterNatsService.name);

  constructor(
    @InjectRepository(ClusterNatsEntity)
    private readonly operators: Repository<ClusterNatsEntity>,
    @InjectRepository(NatsAccountEntity)
    private readonly accounts: Repository<NatsAccountEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async operatorFor(clusterId: string): Promise<ClusterNatsEntity> {
    const existing = await this.operators.findOne({ where: { clusterId } });
    if (existing) return existing;
    const operator = newOperatorKey();
    const system = newAccountKey();
    const row = this.operators.create({
      clusterId,
      operatorSeed: this.encryption.encrypt(seedOf(operator)),
      systemAccountSeed: this.encryption.encrypt(seedOf(system)),
      systemAccount: system.getPublicKey(),
      operatorJwt: operatorJwt(operator, 'flui', system.getPublicKey()),
      systemAccountJwt: accountJwt(
        operator,
        system.getPublicKey(),
        'SYS',
        false,
      ),
    });
    await this.operators.insert(row);
    this.logger.log(`Made the NATS operator of cluster ${clusterId}`);
    return row;
  }

  async deploy(
    clusterId: string,
    storage = process.env.NATS_STORAGE ?? '10Gi',
  ): Promise<void> {
    const operator = await this.operatorFor(clusterId);
    const settings: ClusterNatsSettings = {
      operatorJwt: operator.operatorJwt,
      systemAccount: operator.systemAccount,
      resolverUrl: natsResolverUrl(),
      storage,
    };
    const hash = createHash('sha256')
      .update(natsConfig(settings))
      .digest('hex')
      .slice(0, 16);
    const kubeconfig = await this.kubeconfig(clusterId);
    await this.k8s.ensureNamespaceExists(kubeconfig, NATS_NAMESPACE, {
      'managed-by': 'flui-cloud',
    });
    await this.k8s.applyManifest(kubeconfig, buildNatsConfigMap(settings));
    await this.k8s.applyManifest(kubeconfig, buildNatsService());
    await this.k8s.applyManifest(
      kubeconfig,
      buildNatsStatefulSet(settings, hash),
    );
  }

  /** KEDA, which scales workers on their queue, installed by the cluster's own Helm controller. */
  async ensureKeda(clusterId: string): Promise<void> {
    await this.k8s.applyManifest(
      await this.kubeconfig(clusterId),
      buildKedaHelmChart(),
    );
  }

  /** The JWT of an account any cluster's NATS asks about, or null. JWTs are public. */
  async accountJwt(publicKey: string): Promise<string | null> {
    const system = await this.operators.findOne({
      where: { systemAccount: publicKey },
    });
    if (system) return system.systemAccountJwt;
    const account = await this.accounts.findOne({ where: { publicKey } });
    return account?.jwt ?? null;
  }

  private async kubeconfig(clusterId: string): Promise<string> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${clusterId} has no kubeconfig`);
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}
