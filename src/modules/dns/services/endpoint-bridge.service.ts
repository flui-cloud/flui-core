import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AcmeCertificateService } from '../../providers/services/acme-certificate.service';
import { describeError } from '../../shared/utils/error.util';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { ClusterDnsZoneEntity } from '../entities/cluster-dns-zone.entity';
import {
  BridgeHost,
  BridgeVerdict,
} from '../interfaces/migration-bridge.interface';
import { clusterIngressValues } from '../utils/ingress-addresses.core';
import {
  bridgeObjectRefs,
  retiredBridgeObjectRefs,
  groupBridgeHosts,
  ipv4Only,
  renderBridgeObjects,
  staticBridgeBlocker,
} from '../utils/endpoint-bridge.core';
import { WildcardCertificateService } from './wildcard-certificate.service';
import { ClusterDnsZoneService } from './cluster-dns-zone.service';
import { EndpointBridgeCertificates } from './endpoint-bridge-certificates';

const REQUIRED_CRDS = [
  'ingressroutetcps.traefik.io',
  'ingressroutes.traefik.io',
  'serverstransports.traefik.io',
];

/**
 * The A→B bridge of an application migration: while clients still resolve the
 * old cluster, its ingress forwards the application's names to the new one.
 * Owns the forwarding objects on the source and the certificate the
 * destination must hold before any client is sent there.
 */
@Injectable()
export class EndpointBridgeService {
  private readonly logger = new Logger(EndpointBridgeService.name);

  certificateWaitMs = 5 * 60 * 1000;
  certificatePollMs = 10_000;
  issuerWaitMs = 2 * 60 * 1000;

  private readonly certificates: EndpointBridgeCertificates;

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly assignments: Repository<ClusterDnsZoneEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    acme: AcmeCertificateService,
    wildcard: WildcardCertificateService,
    zones: ClusterDnsZoneService,
  ) {
    this.certificates = new EndpointBridgeCertificates(
      kubernetes,
      acme,
      wildcard,
      zones,
      (endpoint, clusterId) => this.zoneServedOn(endpoint, clusterId),
      () => ({
        pollMs: this.certificatePollMs,
        issuerWaitMs: this.issuerWaitMs,
      }),
    );
  }

  async preflight(input: {
    endpoints: AppEndpointEntity[];
    sourceClusterId: string;
    targetClusterId: string;
    requested: boolean;
  }): Promise<BridgeVerdict> {
    const skip = (skipReason: string): BridgeVerdict => ({
      mode: 'dns-only',
      skipReason,
    });
    if (!input.requested) {
      return skip('The bridge was turned off when the migration was created.');
    }
    const blocker = staticBridgeBlocker(input.endpoints);
    if (blocker) return skip(blocker);

    try {
      const target = await this.cluster(input.targetClusterId);
      if (ipv4Only(clusterIngressValues(target)).length === 0) {
        return skip(
          'The destination cluster has no public IPv4 ingress address to forward to.',
        );
      }
      const kubeconfig = await this.kubeconfig(
        await this.cluster(input.sourceClusterId),
      );
      for (const crd of REQUIRED_CRDS) {
        const served = await this.kubernetes.readObject(
          kubeconfig,
          'apiextensions.k8s.io/v1',
          'CustomResourceDefinition',
          crd,
        );
        if (!served) {
          return skip(
            `The source cluster does not serve ${crd}, which the bridge needs to forward TLS by name.`,
          );
        }
      }
    } catch (err) {
      return skip(`The clusters could not be checked: ${describeError(err)}`);
    }
    return { mode: 'bridge', skipReason: null };
  }

  /** Zone names of these endpoints that the cluster has no assignment for. */
  async zonesMissingOn(
    endpoints: AppEndpointEntity[],
    clusterId: string,
  ): Promise<string[]> {
    const missing = new Set<string>();
    for (const endpoint of endpoints) {
      const current = await this.assignmentOf(endpoint);
      if (!current || current.clusterId === clusterId) continue;
      const there = await this.assignments.findOne({
        where: { clusterId, dnsZoneId: current.dnsZoneId },
      });
      if (!there) {
        missing.add(current.dnsZone?.zoneName ?? current.dnsZoneId);
      }
    }
    return [...missing];
  }

  /**
   * Gives the destination a valid certificate for every bridged name, before
   * any client is forwarded there: with passthrough, clients verify the
   * destination directly.
   */
  async prepare(input: {
    bridgeId: string;
    endpoints: AppEndpointEntity[];
    sourceClusterId: string;
    targetClusterId: string;
    waitMs?: number;
  }): Promise<BridgeHost[]> {
    const kubeSource = await this.kubeconfig(
      await this.cluster(input.sourceClusterId),
    );
    const kubeTarget = await this.kubeconfig(
      await this.cluster(input.targetClusterId),
    );
    const hosts: BridgeHost[] = [];
    for (const group of groupBridgeHosts(input.endpoints)) {
      const members = input.endpoints.filter((e) =>
        group.endpointIds.includes(e.id),
      );
      const certificateRequired = members.some((e) => e.certificateRequired);
      const host: BridgeHost = {
        ...group,
        certificateRequired,
        secretName: null,
        certificate: null,
        certificateReady: !certificateRequired,
        certificateMessage: null,
      };
      if (!certificateRequired) {
        hosts.push(host);
        continue;
      }
      try {
        const prepared = await this.certificates.prepare(
          input.bridgeId,
          members[0],
          host,
          kubeSource,
          kubeTarget,
          input.targetClusterId,
        );
        this.logger.log(
          `[bridge] ${input.bridgeId}: certificate for ${host.fqdn} on ${input.targetClusterId} from ${prepared.certificate} (${prepared.secretName})`,
        );
        hosts.push(prepared);
      } catch (err) {
        this.logger.warn(
          `[bridge] ${input.bridgeId}: no certificate for ${host.fqdn} on ${input.targetClusterId}: ${describeError(err)}`,
        );
        hosts.push({ ...host, certificateMessage: describeError(err) });
      }
    }
    await this.certificates.waitFor(
      hosts,
      kubeTarget,
      input.waitMs ?? this.certificateWaitMs,
      { bridgeId: input.bridgeId, kubeSource, endpoints: input.endpoints },
    );
    return hosts;
  }

  /** Null when every bridged name has a valid certificate on the destination, else why not. */
  async certificatesValid(
    hosts: BridgeHost[],
    targetClusterId: string,
  ): Promise<string | null> {
    const required = hosts.filter((h) => h.certificateRequired);
    if (required.length === 0) return null;
    const kubeconfig = await this.kubeconfig(
      await this.cluster(targetClusterId),
    );
    for (const host of required) {
      if (!host.secretName) {
        return `${host.fqdn} has no certificate on the destination cluster: ${
          host.certificateMessage ?? 'none could be prepared'
        }`;
      }
      const problem = await this.certificates.secretProblem(kubeconfig, host);
      if (problem) {
        return `${host.fqdn} has no valid certificate on the destination cluster yet: ${problem}${
          host.certificateNote ? `. ${host.certificateNote}` : ''
        }`;
      }
    }
    return null;
  }

  /** Applies the forwarding objects on the source; returns the destination addresses used. */
  async activate(
    bridgeId: string,
    hosts: BridgeHost[],
    sourceClusterId: string,
    targetClusterId: string,
  ): Promise<string[]> {
    const addresses = ipv4Only(
      clusterIngressValues(await this.cluster(targetClusterId)),
    );
    if (addresses.length === 0) {
      throw new Error(
        'The destination cluster has no public IPv4 ingress address to forward to',
      );
    }
    const kubeconfig = await this.kubeconfig(
      await this.cluster(sourceClusterId),
    );
    for (const host of hosts) {
      for (const object of renderBridgeObjects({
        bridgeId,
        fqdn: host.fqdn,
        namespace: host.namespace,
        anchorEndpointId: host.endpointIds[0],
        targetAddresses: addresses,
      })) {
        await this.kubernetes.applyManifest(kubeconfig, JSON.stringify(object));
      }
      this.logger.log(
        `[bridge] ${bridgeId}: ${host.fqdn} on ${sourceClusterId} now forwards to ${addresses.join(', ')}`,
      );
    }
    return addresses;
  }

  /** Removes the forwarding objects; returns what could not be removed, or null. */
  async close(
    hosts: BridgeHost[],
    sourceClusterId: string,
  ): Promise<string | null> {
    let kubeconfig: string;
    try {
      kubeconfig = await this.kubeconfig(await this.cluster(sourceClusterId));
    } catch (err) {
      return `The source cluster could not be reached to remove the bridge for ${hosts
        .map((h) => h.fqdn)
        .join(', ')}: ${describeError(err)}`;
    }
    const left: string[] = [];
    for (const host of hosts) {
      for (const ref of [
        ...bridgeObjectRefs(host.namespace, host.endpointIds[0]),
        ...retiredBridgeObjectRefs(host.namespace, host.endpointIds[0]),
      ]) {
        try {
          await this.kubernetes.deleteObject(
            kubeconfig,
            ref.apiVersion,
            ref.kind,
            ref.name,
            ref.namespace,
          );
        } catch (err) {
          left.push(
            `${ref.kind} ${ref.namespace}/${ref.name} (${describeError(err)})`,
          );
        }
      }
    }
    return left.length
      ? `Left on the source cluster: ${left.join('; ')}`
      : null;
  }

  /** Removes the certificates this bridge placed on the destination. */
  async discard(hosts: BridgeHost[], targetClusterId: string): Promise<void> {
    const placed = hosts.filter(
      (h) =>
        h.secretName &&
        (h.certificate === 'dns-01' || h.certificate === 'copied'),
    );
    if (placed.length === 0) return;
    const kubeconfig = await this.kubeconfig(
      await this.cluster(targetClusterId),
    );
    for (const host of placed) {
      for (const kind of ['Certificate', 'Secret']) {
        await this.kubernetes
          .deleteResource(kubeconfig, kind, host.secretName!, host.namespace)
          .catch((err: unknown) =>
            this.logger.warn(
              `[bridge] could not remove ${kind} ${host.namespace}/${host.secretName}: ${describeError(err)}`,
            ),
          );
      }
    }
  }

  private async zoneServedOn(
    endpoint: AppEndpointEntity,
    clusterId: string,
  ): Promise<boolean> {
    if (!(await this.assignmentOf(endpoint))) return false;
    return (await this.zonesMissingOn([endpoint], clusterId)).length === 0;
  }

  private async assignmentOf(
    endpoint: AppEndpointEntity,
  ): Promise<ClusterDnsZoneEntity | null> {
    if (endpoint.clusterDnsZone) return endpoint.clusterDnsZone;
    if (!endpoint.clusterDnsZoneId) return null;
    return this.assignments.findOne({
      where: { id: endpoint.clusterDnsZoneId },
    });
  }

  private async cluster(id: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({ where: { id } });
    if (!cluster) throw new Error(`Cluster ${id} not found`);
    return cluster;
  }

  private async kubeconfig(cluster: ClusterEntity): Promise<string> {
    if (!cluster.kubeconfigEncrypted) {
      throw new Error(
        `Cluster ${cluster.name ?? cluster.id} has no kubeconfig`,
      );
    }
    return this.kubernetes.patchKubeconfigServer(
      this.encryption.decrypt(cluster.kubeconfigEncrypted),
    );
  }
}
