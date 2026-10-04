import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';
import { clusterIngressValues } from '../../dns/utils/ingress-addresses.core';
import { ApplicationVolumeClaimsService } from './application-volume-claims.service';
import {
  AppAvailability,
  appAvailability,
} from '../utils/app-availability.core';

/**
 * Gathers what the availability rule needs — where the copies run, which
 * volumes are tied to a node, which addresses the application answers on and
 * how many nodes take traffic — and lets the rule decide. Read live from the
 * cluster, because the question is about now.
 */
@Injectable()
export class AppAvailabilityService {
  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly appResources: AppResourcesRepository,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpoints: Repository<AppEndpointEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
  ) {}

  async forApplication(appId: string): Promise<AppAvailability> {
    const app = await this.applications.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} has no kubeconfig available`,
      );
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

    const [pods, claims, bindings, endpoints] = await Promise.all([
      this.kubernetes.listPodsByLabel(
        kubeconfig,
        app.k8sNamespace,
        `flui-app-id=${app.id}`,
      ),
      this.appResources.findByApplicationId(app.id).then((rows) =>
        this.volumeClaims.resolveForApplication(kubeconfig, app, rows, {
          excludeCopies: true,
        }),
      ),
      this.kubernetes.listVolumeNodeBindings(kubeconfig, app.k8sNamespace),
      this.endpoints.find({ where: { applicationId: app.id } }),
    ]);

    const boundTo = new Map(bindings.map((b) => [b.claimName, b.node]));
    const scaling = app.scaling;
    const desiredCopies = scaling?.enabled
      ? (scaling.horizontal?.min ?? scaling.minReplicas ?? app.replicas ?? 1)
      : (app.replicas ?? 1);

    return appAvailability({
      desiredCopies,
      readyCopyNodes: pods
        .filter(
          (pod) =>
            !pod.metadata?.deletionTimestamp &&
            (pod.status?.conditions ?? []).some(
              (c) => c.type === 'Ready' && c.status === 'True',
            ),
        )
        .map((pod) => pod.spec?.nodeName ?? '')
        .filter(Boolean),
      ingressNodeCount: clusterIngressValues(cluster).length,
      dedicated: app.persistenceScope === 'dedicated',
      volumes: claims.map((claim) => ({
        name: claim.name,
        boundToNode: boundTo.get(claim.name) ?? null,
      })),
      endpoints: endpoints.map((e) => ({
        fqdn: e.fqdn,
        ipHostname: e.hostnameMode === HostnameMode.IP,
      })),
    });
  }
}
