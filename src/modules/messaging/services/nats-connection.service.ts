import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NatsConnection, connect, jwtAuthenticator } from 'nats';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubePortForwardService } from '../../database-console/services/kube-port-forward.service';
import {
  NATS_CLIENT_PORT,
  NATS_NAME,
  NATS_NAMESPACE,
} from '../nats/cluster-nats.manifest';
import { keyFromSeed, newUserKey, userJwt } from '../nats/nats-jwt';

const USER_TTL_SECONDS = 300;

/**
 * A connection to a cluster's NATS as a user Flui signs for the occasion
 * with an account key, and never stores. Reached through the cluster API, so
 * the server needs no public port.
 */
@Injectable()
export class NatsConnectionService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    private readonly tunnels: KubePortForwardService,
  ) {}

  async withConnection<T>(
    clusterId: string,
    encryptedAccountSeed: string,
    userName: string,
    work: (nc: NatsConnection) => Promise<T>,
  ): Promise<T> {
    const signer = keyFromSeed(this.encryption.decrypt(encryptedAccountSeed));
    const user = newUserKey();
    const jwt = userJwt(
      signer,
      user.getPublicKey(),
      userName,
      USER_TTL_SECONDS,
    );
    const tunnel = await this.tunnels.open(
      await this.kubeconfig(clusterId),
      NATS_NAMESPACE,
      `app=${NATS_NAME}`,
      NATS_CLIENT_PORT,
    );
    try {
      const nc = await connect({
        servers: `127.0.0.1:${tunnel.localPort}`,
        authenticator: jwtAuthenticator(jwt, user.getSeed()),
      });
      try {
        return await work(nc);
      } finally {
        await nc.close();
      }
    } finally {
      await tunnel.dispose();
    }
  }

  private async kubeconfig(clusterId: string): Promise<string> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${clusterId} has no kubeconfig`);
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}
