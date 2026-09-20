import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { pinnedTagForRepository } from '../../../config/release.config';
import {
  bareRepository,
  hasSettled,
  pinImageIn,
} from '../utils/declared-image.util';
import { FileToWrite, ManifestMasterService } from './manifest-master.service';

export type DeclaredImageOutcome =
  /** A manifest was rewritten to name this tag. */
  | 'written'
  /** A manifest already named it. */
  | 'already'
  /** No manifest names this repository, so no restart can reassert one. */
  | 'undeclared'
  /** The declaration could not be reached; what is running is unaffected. */
  | 'failed';

export interface DeclaredImageResult {
  /**
   * Whether no restart of this master can hand a different build back.
   *
   * True for a file that names this tag *and* for no file at all — flui-authz
   * has no declared manifest, because the API installs it itself, so there is
   * nothing there to drift. Both satisfy the one property that matters.
   */
  pinned: boolean;
  outcome: DeclaredImageOutcome;
  /** The manifest files that declare this image. */
  files: string[];
  reason?: string;
}

/**
 * Keeping the image a master *declares* in step with the one it *runs*.
 *
 * An update edits the live Deployment; the manifest k3s re-applies at every
 * start still names the tag the node was built with, so a reboot puts the old
 * build back with no error and no actor to blame.
 *
 * Writes through `ManifestMasterService` for its lock, backup, digest check and
 * staged rename — and to stop needing the privilege and the host `python3` that
 * editing one line used to cost.
 */
@Injectable()
export class DeclaredImageService {
  private readonly logger = new Logger(DeclaredImageService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly master: ManifestMasterService,
  ) {}

  /**
   * @param imageRef the full reference now running, e.g.
   *   `ghcr.io/flui-cloud/core:0.13.0-rc.8`. The repository half decides which
   *   lines are ours to touch; the tag half is what gets written.
   */
  async pin(imageRef: string): Promise<DeclaredImageResult> {
    const access = await this.masterAccess();
    if ('reason' in access) {
      return {
        pinned: false,
        outcome: 'failed',
        files: [],
        reason: access.reason,
      };
    }
    const { kubeconfig, node } = access;

    try {
      const held = await this.master.read(kubeconfig, node);
      const toWrite: FileToWrite[] = [];
      const declaredIn: string[] = [];
      const refusals: string[] = [];

      for (const [name, file] of held) {
        // A file whose content never left the master carries a Secret, and no
        // Flui component's image is declared inside one.
        if (file.content === undefined) continue;

        const outcome = pinImageIn(file.content, imageRef);
        if (outcome.refusal) {
          refusals.push(`${name}: ${outcome.refusal}`);
          continue;
        }
        if (!outcome.declared) continue;

        declaredIn.push(name);
        if (outcome.changed) {
          toWrite.push({
            name,
            content: outcome.content,
            expectCurrentSha: file.sha,
          });
        }
      }

      if (refusals.length > 0) {
        return {
          pinned: false,
          outcome: 'failed',
          files: [],
          reason: `left alone — ${refusals.join('; ')}`,
        };
      }
      if (declaredIn.length === 0) {
        return {
          pinned: true,
          outcome: 'undeclared',
          files: [],
          reason: `no manifest on this master declares ${bareRepository(imageRef.split(':')[0])}, so nothing there can reassert an older one`,
        };
      }
      if (toWrite.length === 0) {
        return { pinned: true, outcome: 'already', files: declaredIn };
      }

      const planId = `declare-${Date.now()}`;
      const wrote = await this.master.write(kubeconfig, node, planId, toWrite);
      return { pinned: true, outcome: 'written', files: wrote };
    } catch (error) {
      // The rollout itself succeeded; failing to write the declaration is worth
      // reporting, never worth failing an update that already happened.
      const reason = (error as Error).message;
      this.logger.warn(`Could not pin ${imageRef} in the manifests: ${reason}`);
      return { pinned: false, outcome: 'failed', files: [], reason };
    }
  }

  /**
   * Declare what is actually running, for every component that has a manifest.
   *
   * Scheduled rather than only run at the end of an update, because the API's
   * own rollout has no code path left to pin from: the pod that would do it is
   * the one being replaced.
   */
  async reconcile(): Promise<Array<DeclaredImageResult & { image: string }>> {
    const images = await this.runningComponentImages();
    const out: Array<DeclaredImageResult & { image: string }> = [];
    for (const image of images) out.push({ image, ...(await this.pin(image)) });
    return out;
  }

  /**
   * What the components are running, asked of the cluster and only once it has
   * settled.
   *
   * Not `applications.observedImageRef`, which a reconciler keeps and can lag:
   * read from there, this declared a superseded build on a cluster running a
   * newer one, and k3s duly rolled the cluster back to it. The Deployment's
   * `spec` is what it has been *told* to run, so it is read only where the
   * status agrees it arrived — pinning a tag mid-rollout would write a build
   * that may never come up, and then every restart would reassert it.
   */
  private async runningComponentImages(): Promise<string[]> {
    const cluster = await this.controlCluster();
    if (!cluster?.kubeconfigEncrypted) return [];
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    const found = new Set<string>();
    for (const namespace of ['flui-system', 'flui-control']) {
      let list;
      try {
        list = await appsApi.listNamespacedDeployment({ namespace });
      } catch {
        // A namespace this installation does not have is not an error: the two
        // names cover both layouts, and every cluster has one of them.
        continue;
      }
      for (const deployment of list.items ?? []) {
        if (!hasSettled(deployment)) continue;
        for (const image of ourImagesIn(deployment)) found.add(image);
      }
    }
    return [...found];
  }

  /** A platform update is always about the cluster this API runs on. */
  private async controlCluster(): Promise<ClusterEntity | null> {
    return this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
      relations: ['nodes'],
    });
  }

  private async masterAccess(): Promise<
    { kubeconfig: string; node: string } | { reason: string }
  > {
    const cluster = await this.controlCluster();
    if (!cluster?.kubeconfigEncrypted) {
      return { reason: 'No kubeconfig for the cluster.' };
    }
    const master = (cluster.nodes ?? []).find((n) => n.nodeType === 'master');
    if (!master?.serverName) {
      return { reason: 'The cluster has no master node recorded to write on.' };
    }
    return {
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
      node: master.serverName,
    };
  }
}

/** The images in one Deployment that this release speaks for. */
function ourImagesIn(deployment: k8s.V1Deployment): string[] {
  const out: string[] = [];
  for (const container of deployment.spec?.template?.spec?.containers ?? []) {
    const image = container.image;
    if (!image) continue;
    const colon = image.lastIndexOf(':');
    if (colon <= 0) continue;
    if (
      pinnedTagForRepository(bareRepository(image.slice(0, colon))) !== null
    ) {
      out.push(image);
    }
  }
  return out;
}
