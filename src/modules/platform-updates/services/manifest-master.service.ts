import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { SAFE_NAME } from '../utils/manifest-render.util';

const MANIFEST_DIR = '/var/lib/rancher/k3s/server/manifests';
const STAGING_DIR = '/var/lib/rancher/k3s/server/flui-refresh-staging';
export const BACKUP_DIR = '/var/lib/rancher/k3s/server/flui-refresh-backup';
const LOCK_DIR = '/var/lib/rancher/k3s/server/.flui-refresh.lock';
const DEFAULT_RESTORE_DIRS = {
  manifests: MANIFEST_DIR,
  backups: BACKUP_DIR,
  lock: LOCK_DIR,
};
const JOB_NAMESPACE = 'flui-local-storage';
const FALLBACK_JOB_NAMESPACE = 'kube-system';
const JOB_TIMEOUT_MS = 180_000;
const JOB_POLL_MS = 2_000;

export interface HeldFile {
  sha: string;
  carriesSecret: boolean;
  /**
   * Only the digest came back because a template of this file names a secret
   * variable, so the rendered copy may hold its value.
   */
  withheld?: boolean;
  /** For a withheld file: every resource in it carries the owner label. */
  declaresProvenance?: boolean;
  /** Absent for a file carrying a Secret or withheld: it never leaves the master. */
  content?: string;
}

/**
 * Files that rendered a secret value into their body in releases published
 * before `manifests/SECRETS` existed. Always withheld: a master can still hold
 * such a copy long after the release that wrote it is forgotten.
 */
export const WITHHELD_BY_HISTORY: readonly string[] = [
  '02-postgres.yaml',
  '03-redis.yaml',
  '04d-alertmanager.yaml',
  '08-grafana.yaml',
  '09-flui-api.yaml',
];

/**
 * The read job's script. The body of a file carrying a Secret, or named in
 * `withhold`, is never printed — pod logs are the channel it would travel on.
 */
export function readScript(
  withhold: Iterable<string> | 'all',
  dir: string = MANIFEST_DIR,
): string {
  const names =
    withhold === 'all'
      ? []
      : [...new Set([...withhold, ...WITHHELD_BY_HISTORY])].filter((n) =>
          SAFE_NAME.test(n),
        );
  return [
    'set -e',
    `cd ${dir} 2>/dev/null || { echo "NODIR"; exit 0; }`,
    `ALL=${withhold === 'all' ? 1 : 0}`,
    `WITHHOLD=" ${names.join(' ')} "`,
    'held_back() {',
    '  [ "$ALL" = 1 ] && return 0',
    '  case "$WITHHOLD" in *" $1 "*) return 0;; esac',
    '  return 1',
    '}',
    'for f in *.yaml; do',
    '  [ -e "$f" ] || continue',
    '  sha=$(sha256sum "$f" | cut -d" " -f1)',
    '  if grep -qE "^kind:[[:space:]]*Secret" "$f"; then',
    '    echo "FILE $f $sha secret"',
    '  elif held_back "$f"; then',
    '    kinds=$(grep -cE "^kind:" "$f" || true)',
    '    owners=$(grep -cE "^[[:space:]]+flui.cloud/owner-kind:" "$f" || true)',
    '    echo "FILE $f $sha withheld $kinds $owners"',
    '  else',
    '    echo "FILE $f $sha plain"',
    '    echo "BODY $(base64 -w0 < "$f")"',
    '  fi',
    'done',
  ].join('\n');
}

export function parseReadLogs(logs: string): Map<string, HeldFile> {
  const held = new Map<string, HeldFile>();
  let last: string | null = null;
  for (const line of logs.split('\n')) {
    if (line.startsWith('FILE ')) {
      const [, name, sha, kind, kinds, owners] = line.trim().split(/\s+/);
      const entry: HeldFile = { sha, carriesSecret: kind === 'secret' };
      if (kind === 'withheld') {
        const resources = Number(kinds);
        entry.withheld = true;
        entry.declaresProvenance = resources > 0 && Number(owners) >= resources;
      }
      held.set(name, entry);
      last = kind === 'plain' ? name : null;
    } else if (line.startsWith('BODY ') && last) {
      const entry = held.get(last);
      if (entry) {
        entry.content = Buffer.from(line.slice(5).trim(), 'base64').toString(
          'utf8',
        );
      }
      last = null;
    }
  }
  return held;
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
 * returns the content of a file that may carry a secret, since its output
 * travels through pod logs. The second writes, and only after every digest
 * still matches.
 */
/** Puts back the files a plan replaced and removes the ones it added. */
export function restoreScript(
  planId: string,
  names: string[],
  dirs = DEFAULT_RESTORE_DIRS,
): string {
  return [
    'set -e',
    `mkdir ${dirs.lock} 2>/dev/null || { echo "LOCKED"; exit 0; }`,
    `trap 'rmdir ${dirs.lock} 2>/dev/null || true' EXIT`,
    `BACK=${dirs.backups}/${planId}`,
    `for name in ${names.join(' ')}; do`,
    `  target=${dirs.manifests}/$name`,
    '  if [ -e "$BACK/$name" ]; then',
    '    cp "$BACK/$name" "$target"; echo "RESTORED $name"',
    '  else',
    '    rm -f "$target"; echo "REMOVED $name"',
    '  fi',
    'done',
  ].join('\n');
}

@Injectable()
export class ManifestMasterService {
  constructor(private readonly kubernetesService: KubernetesService) {}

  /**
   * @param withhold files whose templates name a secret variable, on top of
   *   {@link WITHHELD_BY_HISTORY}; `'all'` returns digests only.
   */
  async read(
    kubeconfig: string,
    node: string,
    withhold: Iterable<string> | 'all' = [],
  ): Promise<Map<string, HeldFile>> {
    const logs = await this.runJob(
      kubeconfig,
      node,
      'flui-manifest-read',
      readScript(withhold),
      false,
    );
    return parseReadLogs(logs);
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

  /**
   * Undoes a write: every file the plan replaced comes back from its backup,
   * and every file it added is removed. K3s re-applies what it finds, so the
   * workloads return to the templates they ran before.
   */
  async restore(
    kubeconfig: string,
    node: string,
    planId: string,
    names: string[],
  ): Promise<string[]> {
    const unsafe = names.find((n) => !SAFE_NAME.test(n));
    if (unsafe || !SAFE_NAME.test(`${planId}.yaml`)) {
      throw new Error(
        `Refusing to restore an unexpected name: ${unsafe ?? planId}`,
      );
    }
    const script = restoreScript(planId, names);
    const logs = await this.runJob(
      kubeconfig,
      node,
      'flui-manifest-restore',
      script,
      true,
    );
    if (logs.includes('LOCKED')) {
      throw new ConflictException(
        `Another refresh holds the lock on the master, so the files were not put back. Remove ${LOCK_DIR} if it is stale and restore from ${BACKUP_DIR}/${planId}.`,
      );
    }
    return logs
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('RESTORED ') || l.startsWith('REMOVED '));
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
    const namespace = await this.jobNamespace(kubeconfig);

    try {
      if (payload !== undefined) {
        await this.kubernetesService.applyManifest(
          kubeconfig,
          this.payloadManifest(name, namespace, payload),
        );
      }
      await this.kubernetesService.applyManifest(
        kubeconfig,
        this.jobManifest(
          name,
          namespace,
          node,
          script,
          writable,
          payload !== undefined,
        ),
      );
      await this.awaitJob(kubeconfig, name, namespace);
      return await this.readJobLogs(kubeconfig, name, namespace);
    } finally {
      await this.kubernetesService
        .deleteResource(kubeconfig, 'Job', name, namespace)
        .catch(() => undefined);
      if (payload !== undefined) {
        await this.kubernetesService
          .deleteResource(kubeconfig, 'ConfigMap', name, namespace)
          .catch(() => undefined);
      }
    }
  }

  /**
   * `flui-local-storage` where the cluster has it; `kube-system` on a master
   * installed before that namespace existed.
   */
  async jobNamespace(kubeconfig: string): Promise<string> {
    try {
      const ns = await this.kubernetesService.readObject(
        kubeconfig,
        'v1',
        'Namespace',
        JOB_NAMESPACE,
      );
      return ns ? JOB_NAMESPACE : FALLBACK_JOB_NAMESPACE;
    } catch {
      return FALLBACK_JOB_NAMESPACE;
    }
  }

  private payloadManifest(
    name: string,
    namespace: string,
    payload: string,
  ): string {
    const indented = payload
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    return [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      `  name: ${name}`,
      `  namespace: ${namespace}`,
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
    namespace: string,
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
      `  namespace: ${namespace}`,
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

  private async awaitJob(
    kubeconfig: string,
    name: string,
    namespace: string,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < JOB_TIMEOUT_MS) {
      const job = await this.kubernetesService.getResource(
        kubeconfig,
        'Job',
        name,
        namespace,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return;
      if ((job?.status?.failed ?? 0) > 0) {
        const logs = await this.readJobLogs(kubeconfig, name, namespace).catch(
          () => '',
        );
        throw new Error(
          `The job on the master failed. ${logs.split('\n').filter(Boolean).slice(-3).join(' ')}`.trim(),
        );
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error('The job on the master did not finish in time.');
  }

  private async readJobLogs(
    kubeconfig: string,
    name: string,
    namespace: string,
  ): Promise<string> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace,
      labelSelector: `flui-manifest-job=${name}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) throw new Error(`no pod found for job ${name}`);
    return this.kubernetesService.getPodLogs(kubeconfig, podName, namespace);
  }
}
