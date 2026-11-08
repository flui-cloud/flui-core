import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  LINSTOR_CONTROLLER_DEPLOYMENT,
  PIRAEUS_MANIFEST_URL,
  PIRAEUS_NAMESPACE,
  PIRAEUS_OPERATOR_DEPLOYMENT,
  PIRAEUS_VERSION,
  REPLICATED_STORAGE_CLASS,
} from '../replicated-volumes.constants';
import {
  SATELLITE_SELECTOR,
  controlPodsOnCopies,
  stuckSatellites,
  renderLinstorCluster,
  renderReplicatedStorageClass,
  renderSatelliteConfigurations,
} from '../utils/replicated-volumes.core';
import { pinnedPiraeusManifest } from '../utils/piraeus-images';

const READY_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

/**
 * Installs the replicated volume engine (Piraeus, with LINSTOR and DRBD) on a
 * cluster the first time someone enables replicated volumes there, and never
 * before. Applied server-side, like CloudNativePG: the resource definitions
 * are too large for a client-side apply.
 */
@Injectable()
export class PiraeusInstallerService {
  private readonly logger = new Logger(PiraeusInstallerService.name);
  private manifestCache: string | null = null;

  constructor(private readonly kubernetesService: KubernetesService) {}

  async isInstalled(kubeconfig: string): Promise<boolean> {
    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'Deployment',
      PIRAEUS_OPERATOR_DEPLOYMENT,
      PIRAEUS_NAMESPACE,
    );
    return Boolean(existing);
  }

  async hasStorageClass(kubeconfig: string): Promise<boolean> {
    return !!(await this.readStorageClass(kubeconfig));
  }

  async readStorageClass(
    kubeconfig: string,
  ): Promise<k8s.V1StorageClass | null> {
    const storage = this.kubernetesService
      .makeKubeConfig(kubeconfig)
      .makeApiClient(k8s.StorageV1Api);
    try {
      return await storage.readStorageClass({ name: REPLICATED_STORAGE_CLASS });
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  }

  async ensureOperator(kubeconfig: string): Promise<void> {
    if (!(await this.isInstalled(kubeconfig))) {
      this.logger.log(`Installing Piraeus ${PIRAEUS_VERSION}`);
      const applied = await this.kubernetesService.serverSideApply(
        kubeconfig,
        await this.fetchManifest(),
      );
      this.logger.log(`Piraeus: ${applied} objects applied`);
    }
    await this.waitDeployment(kubeconfig, PIRAEUS_OPERATOR_DEPLOYMENT);
  }

  async ensureCluster(
    kubeconfig: string,
    voteZones: string[] = [],
  ): Promise<void> {
    const objects = [
      renderLinstorCluster(voteZones),
      ...renderSatelliteConfigurations(),
    ];
    await this.kubernetesService.serverSideApply(
      kubeconfig,
      objects.map((o) => k8s.dumpYaml(o)).join('---\n'),
    );
    await this.waitDeployment(kubeconfig, LINSTOR_CONTROLLER_DEPLOYMENT);
  }

  /** The satellites of `nodes` waiting out a crash backoff start again now, not minutes later. */
  async restartStuckSatellites(
    kubeconfig: string,
    nodes: string[],
  ): Promise<string[]> {
    const core = this.kubernetesService
      .makeKubeConfig(kubeconfig)
      .makeApiClient(k8s.CoreV1Api);
    const pods = await core.listNamespacedPod({
      namespace: PIRAEUS_NAMESPACE,
      labelSelector: SATELLITE_SELECTOR,
    });
    const stuck = stuckSatellites(pods.items ?? [], nodes);
    for (const name of stuck) {
      await core.deleteNamespacedPod({ name, namespace: PIRAEUS_NAMESPACE });
    }
    return stuck;
  }

  /** Deleting the pod, not patching the Deployment, leaves the operator nothing to reconcile back. */
  async moveControlOffCopies(
    kubeconfig: string,
    storageNodes: string[],
  ): Promise<string[]> {
    const core = this.kubernetesService
      .makeKubeConfig(kubeconfig)
      .makeApiClient(k8s.CoreV1Api);
    const pods = await core.listNamespacedPod({ namespace: PIRAEUS_NAMESPACE });
    const moved = controlPodsOnCopies(pods.items ?? [], storageNodes);
    for (const name of moved) {
      await core.deleteNamespacedPod({ name, namespace: PIRAEUS_NAMESPACE });
    }
    if (moved.length) {
      await this.waitDeployment(kubeconfig, LINSTOR_CONTROLLER_DEPLOYMENT);
    }
    return moved;
  }

  /**
   * A storage class's parameters cannot change, so a class made with other
   * ones is replaced. Volumes already made keep their copies where they are.
   */
  async ensureStorageClass(kubeconfig: string, copies: number): Promise<void> {
    const desired = renderReplicatedStorageClass(copies);
    const current = await this.readStorageClass(kubeconfig);
    if (
      current &&
      JSON.stringify(current.parameters ?? {}) !==
        JSON.stringify(sortedKeys(desired.parameters as Record<string, string>))
    ) {
      await this.kubernetesService
        .makeKubeConfig(kubeconfig)
        .makeApiClient(k8s.StorageV1Api)
        .deleteStorageClass({ name: REPLICATED_STORAGE_CLASS });
    }
    await this.kubernetesService.serverSideApply(
      kubeconfig,
      k8s.dumpYaml(desired),
    );
  }

  private async fetchManifest(): Promise<string> {
    if (this.manifestCache) return this.manifestCache;
    const response = await fetch(PIRAEUS_MANIFEST_URL);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch the Piraeus manifest from ${PIRAEUS_MANIFEST_URL}: ${response.status} ${response.statusText}`,
      );
    }
    this.manifestCache = pinnedPiraeusManifest(await response.text());
    return this.manifestCache;
  }

  private async waitDeployment(
    kubeconfig: string,
    name: string,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < READY_TIMEOUT_MS) {
      const resource = await this.kubernetesService.getResource(
        kubeconfig,
        'Deployment',
        name,
        PIRAEUS_NAMESPACE,
      );
      const body = resource?.body ?? resource;
      const desired = body?.spec?.replicas ?? 1;
      if (body && (body?.status?.availableReplicas ?? 0) >= desired) return;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `${name} did not become ready within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }
}

function sortedKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}
