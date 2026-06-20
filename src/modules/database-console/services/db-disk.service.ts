import { Inject, Injectable } from '@nestjs/common';
import type { V1Pod } from '@kubernetes/client-node';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  DB_CONNECTION_RESOLVER,
  DbConnectionResolveInput,
  DbConnectionResolver,
} from '../interfaces/db-connection';

export interface DbDiskInfo {
  available: boolean;
  reason: string | null;
  engine: string | null;
  /** Mount path of the app's persistent volume inside the pod. */
  mountPath: string | null;
  /**
   * Numbers are for the FILESYSTEM hosting the volume, not the per-PVC subdirectory:
   * Flui storage classes are local-path (subdirs on a shared node filesystem), which expose
   * no per-PVC accounting. The meaningful "near full" boundary for these is exactly the
   * hosting filesystem — when it fills, the database stops. Per-PVC usage + enforced capacity
   * is the proper fix tracked in the shared backlog (XFS quota / LVM-CSI).
   */
  used_bytes: number | null;
  size_bytes: number | null;
  available_bytes: number | null;
  utilization_percent: number | null;
  alert_level: 'none' | 'warning' | 'critical';
}

function shq(v: string): string {
  const escaped = v.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

const EMPTY = {
  engine: null,
  mountPath: null,
  used_bytes: null,
  size_bytes: null,
  available_bytes: null,
  utilization_percent: null,
  alert_level: 'none' as const,
};

/**
 * Disk usage for a database app, read on demand with `df` inside the pod. Interim solution
 * (no structural storage change): Flui storage classes are local-path subdirs that expose no
 * per-PVC metric, so we report the hosting filesystem's fullness — the real boundary at which
 * the DB runs out of space — and raise a near-full alert. The native per-volume metric +
 * enforced capacity is in the shared backlog.
 */
@Injectable()
export class DbDiskService {
  constructor(
    @Inject(DB_CONNECTION_RESOLVER)
    private readonly resolver: DbConnectionResolver,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async usage(input: DbConnectionResolveInput): Promise<DbDiskInfo> {
    const r = await this.resolver.resolve(input);
    const kubeconfig = await this.clusters.getKubeconfig(r.target.clusterId);
    const pods = await this.kubernetes.listPodsByLabel(
      kubeconfig,
      r.target.namespace,
      r.target.podLabelSelector,
    );
    const pod = pods.find((p) => p.status?.phase === 'Running') ?? pods[0];
    if (!pod) {
      return { ...EMPTY, available: false, reason: 'No running pod found.' };
    }

    const mount = this.findPvcMount(pod);
    if (!mount) {
      return {
        ...EMPTY,
        engine: r.engine,
        available: false,
        reason: 'This database has no persistent volume.',
      };
    }

    let out: string;
    try {
      out = await this.kubernetes.execInPod(
        kubeconfig,
        r.target.namespace,
        r.target.podLabelSelector,
        mount.container,
        ['sh', '-c', `df -P -B1 ${shq(mount.path)} 2>/dev/null | tail -1`],
      );
    } catch {
      return {
        ...EMPTY,
        engine: r.engine,
        mountPath: mount.path,
        available: false,
        reason: 'Could not read disk usage from the pod.',
      };
    }

    const parsed = this.parseDf(out);
    if (!parsed) {
      return {
        ...EMPTY,
        engine: r.engine,
        mountPath: mount.path,
        available: false,
        reason: 'Could not parse disk usage.',
      };
    }

    const utilization =
      parsed.size > 0 ? (parsed.used / parsed.size) * 100 : null;
    let alertLevel: 'none' | 'warning' | 'critical' = 'none';
    if (utilization !== null) {
      if (utilization >= 95) alertLevel = 'critical';
      else if (utilization >= 80) alertLevel = 'warning';
    }

    return {
      available: true,
      reason: null,
      engine: r.engine,
      mountPath: mount.path,
      used_bytes: parsed.used,
      size_bytes: parsed.size,
      available_bytes: parsed.avail,
      utilization_percent: utilization,
      alert_level: alertLevel,
    };
  }

  /** First container mount backed by a PersistentVolumeClaim. */
  private findPvcMount(pod: V1Pod): { path: string; container: string } | null {
    const spec = pod.spec;
    if (!spec) return null;
    const pvcVolumes = new Set(
      (spec.volumes ?? [])
        .filter((v) => v.persistentVolumeClaim)
        .map((v) => v.name),
    );
    for (const c of spec.containers ?? []) {
      for (const m of c.volumeMounts ?? []) {
        if (pvcVolumes.has(m.name)) {
          return { path: m.mountPath, container: c.name };
        }
      }
    }
    return null;
  }

  /** Parse a `df -P -B1` data line: "<fs> <size> <used> <avail> <cap%> <mount>". */
  private parseDf(
    line: string,
  ): { size: number; used: number; avail: number } | null {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const size = Number(parts[1]);
    const used = Number(parts[2]);
    const avail = Number(parts[3]);
    if (![size, used, avail].every((n) => Number.isFinite(n))) return null;
    return { size, used, avail };
  }
}
