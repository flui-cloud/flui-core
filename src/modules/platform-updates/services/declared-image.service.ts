import { randomBytes } from 'node:crypto';
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

const MANIFEST_DIR = '/var/lib/rancher/k3s/server/manifests';
const JOB_NAMESPACE = 'flui-local-storage';
const JOB_TIMEOUT_MS = 120_000;
const JOB_POLL_MS = 2_000;

export interface DeclaredImageResult {
  /** False when the declared state could not be reached; the update still happened. */
  pinned: boolean;
  /** The manifest files whose image line was rewritten. */
  files: string[];
  reason?: string;
}

/**
 * Keeping the declared image in step with the running one.
 *
 * An in-app update edits the live Deployment and nothing else, while the
 * manifest k3s re-applies at every start still names the old tag — so a restart
 * silently puts the old build back, with no error and no actor. That symptom is
 * close to unattributable from outside, which is why this runs as part of the
 * update rather than waiting for somebody to notice.
 *
 * It rewrites one line per file: the image of the repository just updated. The
 * file is rebuilt beside the original and checked for parsing before it moves,
 * because k3s applies a half-written manifest as eagerly as a whole one.
 */
/** The images in one Deployment that this release speaks for. */
function ourImagesIn(deployment: k8s.V1Deployment): string[] {
  const out: string[] = [];
  for (const container of deployment.spec?.template?.spec?.containers ?? []) {
    const image = container.image;
    if (!image) continue;
    const colon = image.lastIndexOf(':');
    if (colon <= 0) continue;
    const repository = image.slice(0, colon).replace(/^[^/]+\//, '');
    if (pinnedTagForRepository(repository) !== null) out.push(image);
  }
  return out;
}

@Injectable()
export class DeclaredImageService {
  private readonly logger = new Logger(DeclaredImageService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * @param imageRef the full reference just rolled out, e.g.
   *   `ghcr.io/flui-cloud/core:0.13.0-rc.8`. The repository half decides which
   *   lines are ours to touch; the tag half is what gets written.
   */
  async pin(imageRef: string): Promise<DeclaredImageResult> {
    const split = imageRef.lastIndexOf(':');
    if (split <= 0 || imageRef.slice(split + 1).includes('/')) {
      return {
        pinned: false,
        files: [],
        reason: `"${imageRef}" carries no tag, so there is nothing to declare.`,
      };
    }
    const repository = imageRef.slice(0, split);

    const cluster = await this.controlCluster();
    if (!cluster?.kubeconfigEncrypted) {
      return {
        pinned: false,
        files: [],
        reason: 'No kubeconfig for the cluster.',
      };
    }
    const master = (cluster.nodes ?? []).find((n) => n.nodeType === 'master');
    if (!master?.serverName) {
      return {
        pinned: false,
        files: [],
        reason: 'The cluster has no master node recorded to write on.',
      };
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const jobName = `flui-declare-image-${Date.now()}-${randomBytes(3).toString('hex')}`;

    try {
      await this.kubernetesService.applyManifest(
        kubeconfig,
        this.buildJobManifest(jobName, master.serverName, repository, imageRef),
      );
      await this.awaitJob(kubeconfig, jobName);
      const logs = await this.readJobLogs(kubeconfig, jobName);
      return this.parse(logs);
    } catch (error) {
      // The update itself succeeded; failing to write the declaration is worth
      // reporting, never worth failing the update that already rolled out.
      const reason = (error as Error).message;
      this.logger.warn(`Could not pin ${imageRef} in the manifests: ${reason}`);
      return { pinned: false, files: [], reason };
    } finally {
      await this.kubernetesService
        .deleteResource(kubeconfig, 'Job', jobName, JOB_NAMESPACE)
        .catch(() => undefined);
    }
  }

  /**
   * Repair for an installation that already drifted.
   *
   * Pinning happens on update, so an installation whose declared tag was never
   * brought into line still names the old one and will hand it back at the next
   * reboot. This is the way to say "declare what is actually running" without
   * waiting for another release.
   */
  async reconcile(): Promise<Array<DeclaredImageResult & { image: string }>> {
    const images = await this.runningComponentImages();
    const out: Array<DeclaredImageResult & { image: string }> = [];
    for (const image of images) out.push({ image, ...(await this.pin(image)) });
    return out;
  }

  /**
   * What the components are running, asked of the cluster.
   *
   * Not of `applications.observedImageRef`, which is a record kept by a
   * reconciler and can lag: read from there, this repair declared a superseded
   * build on a cluster running a newer one, and k3s duly rolled the cluster
   * back to it. The Deployment is the only account of what is running
   * that cannot be stale, because it is the thing that decides it.
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
      for (const dep of list.items ?? []) {
        for (const image of ourImagesIn(dep)) found.add(image);
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

  private buildScript(repository: string, imageRef: string): string {
    return [
      'set -e',
      `DIR=${MANIFEST_DIR}`,
      `REPO="${repository}"`,
      `REF="${imageRef}"`,
      '[ -d "$DIR" ] || { echo "SKIP no manifest directory on this node"; exit 0; }',
      'for f in "$DIR"/*.yaml; do',
      '  grep -q "image: ${REPO}:" "$f" 2>/dev/null || continue',
      '  if grep -q "image: ${REF}$" "$f" 2>/dev/null; then echo "ALREADY $(basename $f)"; continue; fi',
      '  tmp="$f.flui-new"',
      '  sed "s|image: ${REPO}:.*|image: ${REF}|" "$f" > "$tmp"',
      '  if ! python3 -c "import sys,yaml; list(yaml.safe_load_all(open(sys.argv[1])))" "$tmp" 2>/dev/null; then',
      '    rm -f "$tmp"; echo "REFUSED $(basename $f) would not parse after the rewrite"; continue',
      '  fi',
      '  mv "$tmp" "$f"',
      '  echo "PINNED $(basename $f)"',
      'done',
    ].join('\n');
  }

  private buildJobManifest(
    jobName: string,
    node: string,
    repository: string,
    imageRef: string,
  ): string {
    const scriptBlock = this.buildScript(repository, imageRef)
      .split('\n')
      .map((line) => `            ${line}`)
      .join('\n');

    return [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${jobName}`,
      `  namespace: ${JOB_NAMESPACE}`,
      '  labels:',
      '    flui.cloud/managed-by: flui-cloud',
      '    flui-resource-type: declared-image',
      'spec:',
      '  ttlSecondsAfterFinished: 60',
      '  backoffLimit: 0',
      '  template:',
      '    metadata:',
      '      labels:',
      '        flui.cloud/managed-by: flui-cloud',
      `        flui-declare-image-job: ${jobName}`,
      '    spec:',
      '      restartPolicy: Never',
      '      hostPID: true',
      '      nodeSelector:',
      `        kubernetes.io/hostname: ${node}`,
      '      tolerations:',
      '      - key: node-role.kubernetes.io/control-plane',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      - key: node-role.kubernetes.io/master',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      containers:',
      '      - name: declare',
      '        image: alpine:3.20',
      '        securityContext:',
      '          privileged: true',
      '        command: ["sh","-c"]',
      '        args:',
      '        - |',
      '          apk add --no-cache util-linux >/dev/null 2>&1 || true',
      "          SCRIPT=$(cat <<'FLUIDECLARE'",
      scriptBlock,
      '          FLUIDECLARE',
      '          )',
      '          nsenter -t 1 -m -- /bin/sh -c "$SCRIPT"',
      '',
    ].join('\n');
  }

  private async awaitJob(kubeconfig: string, jobName: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < JOB_TIMEOUT_MS) {
      const job = await this.kubernetesService.getResource(
        kubeconfig,
        'Job',
        jobName,
        JOB_NAMESPACE,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return;
      if ((job?.status?.failed ?? 0) > 0) {
        throw new Error(`job ${jobName} failed`);
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error(`job ${jobName} timed out`);
  }

  private async readJobLogs(
    kubeconfig: string,
    jobName: string,
  ): Promise<string> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: JOB_NAMESPACE,
      labelSelector: `flui-declare-image-job=${jobName}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) throw new Error(`no pod found for job ${jobName}`);
    return this.kubernetesService.getPodLogs(
      kubeconfig,
      podName,
      JOB_NAMESPACE,
    );
  }

  private parse(logs: string): DeclaredImageResult {
    const files: string[] = [];
    const refused: string[] = [];

    for (const line of logs.split('\n').map((l) => l.trim())) {
      if (line.startsWith('PINNED ')) files.push(line.slice('PINNED '.length));
      if (line.startsWith('ALREADY '))
        files.push(line.slice('ALREADY '.length));
      if (line.startsWith('REFUSED '))
        refused.push(line.slice('REFUSED '.length));
      if (line.startsWith('SKIP ')) {
        return { pinned: false, files: [], reason: line.slice('SKIP '.length) };
      }
    }

    if (refused.length > 0) {
      return {
        pinned: false,
        files,
        reason: `left alone because the rewrite would not parse: ${refused.join(', ')}`,
      };
    }
    return { pinned: true, files };
  }
}
