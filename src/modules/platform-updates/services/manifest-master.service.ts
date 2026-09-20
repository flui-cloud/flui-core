import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

const MANIFEST_DIR = '/var/lib/rancher/k3s/server/manifests';
const STAGING_DIR = '/var/lib/rancher/k3s/server/flui-refresh-staging';
export const BACKUP_DIR = '/var/lib/rancher/k3s/server/flui-refresh-backup';
const LOCK_DIR = '/var/lib/rancher/k3s/server/.flui-refresh.lock';
const JOB_NAMESPACE = 'flui-local-storage';
const JOB_TIMEOUT_MS = 180_000;
const JOB_POLL_MS = 2_000;

export interface HeldFile {
  sha: string;
  carriesSecret: boolean;
  /** Absent for a file carrying a Secret: its content never leaves the master. */
  content?: string;
}

export interface FileToWrite {
  name: string;
  content: string;
  expectCurrentSha?: string;
}

/**
 * The only part of a manifest refresh that touches the master.
 *
 * Two jobs, neither privileged and neither taking the host's process namespace:
 * a `hostPath` mount of the one directory is all either needs. The first never
 * returns the content of a file carrying a Secret — that would travel through
 * pod logs. The second writes, and only after every digest still matches.
 */
@Injectable()
export class ManifestMasterService {
  private readonly logger = new Logger(ManifestMasterService.name);

  constructor(private readonly kubernetesService: KubernetesService) {}

  async read(kubeconfig: string, node: string): Promise<Map<string, HeldFile>> {
    const script = [
      'set -e',
      `cd ${MANIFEST_DIR} 2>/dev/null || { echo "NODIR"; exit 0; }`,
      'for f in *.yaml; do',
      '  [ -e "$f" ] || continue',
      '  sha=$(sha256sum "$f" | cut -d" " -f1)',
      '  if grep -qE "^kind:[[:space:]]*Secret" "$f"; then',
      '    echo "FILE $f $sha secret"',
      '  else',
      '    echo "FILE $f $sha plain"',
      '    echo "BODY $(base64 -w0 "$f")"',
      '  fi',
      'done',
    ].join('\n');

    const logs = await this.runJob(
      kubeconfig,
      node,
      'flui-manifest-read',
      script,
      false,
    );
    const held = new Map<string, HeldFile>();
    let last: string | null = null;
    for (const line of logs.split('\n')) {
      if (line.startsWith('FILE ')) {
        const [, name, sha, kind] = line.trim().split(/\s+/);
        held.set(name, { sha, carriesSecret: kind === 'secret' });
        last = name;
      } else if (line.startsWith('BODY ') && last) {
        const entry = held.get(last);
        if (entry) {
          entry.content = Buffer.from(line.slice(5).trim(), 'base64').toString(
            'utf8',
          );
        }
      }
    }
    return held;
  }

  /**
   * Every digest is checked before anything moves, the new files are staged
   * outside the directory k3s watches, and only then renamed into place. k3s
   * applies whatever appears in that directory as eagerly as it applies a whole
   * file, so a file must never exist there in a half-written state.
   */
  async write(
    kubeconfig: string,
    node: string,
    planId: string,
    files: FileToWrite[],
  ): Promise<string[]> {
    const payload = files
      .map(
        (f) =>
          `${f.name} ${f.expectCurrentSha ?? '-'} ${Buffer.from(f.content, 'utf8').toString('base64')}`,
      )
      .join('\n');

    const script = [
      'set -e',
      `PLAN=${planId}`,
      `mkdir ${LOCK_DIR} 2>/dev/null || { echo "LOCKED"; exit 0; }`,
      `trap 'rmdir ${LOCK_DIR} 2>/dev/null || true' EXIT`,
      `STAGE=${STAGING_DIR}/$PLAN`,
      `BACK=${BACKUP_DIR}/$PLAN`,
      'rm -rf "$STAGE"; mkdir -p "$STAGE" "$BACK"',
      'while read -r name expect body; do',
      '  [ -n "$name" ] || continue',
      `  target=${MANIFEST_DIR}/$name`,
      '  if [ "$expect" = "-" ]; then',
      '    [ -e "$target" ] && { echo "CONFLICT $name appeared"; exit 1; }',
      '  else',
      '    actual=$(sha256sum "$target" 2>/dev/null | cut -d" " -f1)',
      '    [ "$actual" = "$expect" ] || { echo "CONFLICT $name changed"; exit 1; }',
      '  fi',
      '  echo "$body" | base64 -d > "$STAGE/$name"',
      'done < /flui/payload',
      'while read -r name expect body; do',
      '  [ -n "$name" ] || continue',
      `  target=${MANIFEST_DIR}/$name`,
      '  [ -e "$target" ] && cp "$target" "$BACK/$name"',
      '  mv "$STAGE/$name" "$target"',
      '  echo "WROTE $name"',
      'done < /flui/payload',
      'rm -rf "$STAGE"',
    ].join('\n');

    const logs = await this.runJob(
      kubeconfig,
      node,
      'flui-manifest-write',
      script,
      true,
      payload,
    );
    if (logs.includes('LOCKED')) {
      throw new ConflictException(
        `Another refresh holds the lock on the master. Wait for it, or remove ${LOCK_DIR} if it is stale.`,
      );
    }
    const conflict = logs
      .split('\n')
      .find((l) => l.trim().startsWith('CONFLICT '));
    if (conflict) {
      throw new ConflictException(
        `${conflict.trim().slice('CONFLICT '.length)} on the master while applying. Nothing was written; run the dry run again.`,
      );
    }
    return logs
      .split('\n')
      .filter((l) => l.trim().startsWith('WROTE '))
      .map((l) => l.trim().slice('WROTE '.length));
  }

  private async runJob(
    kubeconfig: string,
    node: string,
    prefix: string,
    script: string,
    writable: boolean,
    payload?: string,
  ): Promise<string> {
    const name = `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}`;

    try {
      if (payload !== undefined) {
        await this.kubernetesService.applyManifest(
          kubeconfig,
          this.payloadManifest(name, payload),
        );
      }
      await this.kubernetesService.applyManifest(
        kubeconfig,
        this.jobManifest(name, node, script, writable, payload !== undefined),
      );
      await this.awaitJob(kubeconfig, name);
      return await this.readJobLogs(kubeconfig, name);
    } finally {
      await this.kubernetesService
        .deleteResource(kubeconfig, 'Job', name, JOB_NAMESPACE)
        .catch(() => undefined);
      if (payload !== undefined) {
        await this.kubernetesService
          .deleteResource(kubeconfig, 'ConfigMap', name, JOB_NAMESPACE)
          .catch(() => undefined);
      }
    }
  }

  private payloadManifest(name: string, payload: string): string {
    const indented = payload
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    return [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${JOB_NAMESPACE}`,
      'data:',
      '  payload: |',
      indented,
      '',
    ].join('\n');
  }

  /**
   * A hostPath mount of the one directory, and nothing else.
   *
   * The privileged + `hostPID` + `nsenter` shape used elsewhere in this module
   * exists there to borrow the host's `sed` and `python3`. Nothing here needs a
   * host binary, so taking the host's process namespace and full privilege for
   * convenience would be a cost paid for nothing.
   */
  private jobManifest(
    name: string,
    node: string,
    script: string,
    writable: boolean,
    withPayload: boolean,
  ): string {
    const lines = [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${JOB_NAMESPACE}`,
      '  labels:',
      '    flui.cloud/managed-by: flui-cloud',
      '    flui-resource-type: manifest-refresh',
      'spec:',
      '  ttlSecondsAfterFinished: 120',
      '  backoffLimit: 0',
      '  template:',
      '    metadata:',
      '      labels:',
      '        flui.cloud/managed-by: flui-cloud',
      `        flui-manifest-job: ${name}`,
      '    spec:',
      '      restartPolicy: Never',
      '      nodeSelector:',
      `        kubernetes.io/hostname: ${node}`,
      '      tolerations:',
      '      - key: node-role.kubernetes.io/control-plane',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      - key: node-role.kubernetes.io/master',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      volumes:',
      '      - name: server',
      '        hostPath:',
      '          path: /var/lib/rancher/k3s/server',
      '          type: Directory',
    ];
    if (withPayload) {
      lines.push(
        '      - name: payload',
        '        configMap:',
        `          name: ${name}`,
      );
    }
    lines.push(
      '      containers:',
      '      - name: refresh',
      '        image: alpine:3.20',
      '        volumeMounts:',
      '        - name: server',
      '          mountPath: /var/lib/rancher/k3s/server',
      `          readOnly: ${writable ? 'false' : 'true'}`,
    );
    if (withPayload) {
      lines.push(
        '        - name: payload',
        '          mountPath: /flui',
        '          readOnly: true',
      );
    }
    lines.push(
      '        command: ["sh","-c"]',
      '        args:',
      '        - |',
      ...script.split('\n').map((l) => `          ${l}`),
      '',
    );
    return lines.join('\n');
  }

  private async awaitJob(kubeconfig: string, name: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < JOB_TIMEOUT_MS) {
      const job = await this.kubernetesService.getResource(
        kubeconfig,
        'Job',
        name,
        JOB_NAMESPACE,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return;
      if ((job?.status?.failed ?? 0) > 0) {
        const logs = await this.readJobLogs(kubeconfig, name).catch(() => '');
        throw new Error(
          `The job on the master failed. ${logs.split('\n').filter(Boolean).slice(-3).join(' ')}`.trim(),
        );
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error('The job on the master did not finish in time.');
  }

  private async readJobLogs(kubeconfig: string, name: string): Promise<string> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: JOB_NAMESPACE,
      labelSelector: `flui-manifest-job=${name}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) throw new Error(`no pod found for job ${name}`);
    return this.kubernetesService.getPodLogs(
      kubeconfig,
      podName,
      JOB_NAMESPACE,
    );
  }
}
