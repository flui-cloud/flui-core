import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { dump } from 'js-yaml';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  PoolerSpec,
  PoolerUpstream,
  poolerNames,
  poolerUpstreamObjects,
} from '../../applications/utils/db-pooler.core';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { physicalNames } from '../utils/physical-replication.core';
import { PAUSE_POLL_MS } from '../utils/pooler-cut.core';
import {
  PROBE_WINDOW_MS,
  PoolerPods,
  PoolerTarget,
  messageOf,
} from './pooler-pods';

const SERVICE_GONE_MS = 15_000;

/** Where a pooler's upstream Service sends sessions: its own database or the forward. */
export class PoolerUpstreamSwitch {
  constructor(
    private readonly apps: Repository<ApplicationEntity>,
    private readonly k8s: KubernetesService,
    private readonly pods: PoolerPods,
    private readonly logger: Logger,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /**
   * A selector cannot be merged away, so the upstream Service is deleted and
   * created again on the same cluster IP. Back to local, the forward slice
   * goes first and the switch ends once the only endpoints the Service has
   * are the controller's, on the database pod.
   */
  async switchUpstream(
    t: PoolerTarget,
    upstream: PoolerUpstream,
  ): Promise<void> {
    const spec = t.app.pooler;
    if (!spec?.enabled) throw new Error(`${t.app.slug} has no pooler`);
    const names = poolerNames(t.app.slug);
    const { kubeconfig, namespace } = t.db;
    const current = await this.k8s
      .getResource(kubeconfig, 'Service', names.upstream, namespace)
      .catch(() => null);
    const clusterIP: string | null =
      spec.upstreamClusterIP ?? current?.spec?.clusterIP ?? null;
    if (!clusterIP || clusterIP === 'None') {
      throw new Error(
        `The pooler of ${t.app.slug} has no upstream address to keep`,
      );
    }
    const previous: PoolerSpec = { ...spec, upstreamClusterIP: clusterIP };
    if (spec.upstreamClusterIP !== clusterIP) {
      await this.apps.update(t.app.id, { pooler: previous } as never);
      t.app.pooler = previous;
    }
    const next: PoolerSpec = { ...previous, upstream };
    const objects = poolerUpstreamObjects(t.app, next);
    if (upstream.mode === 'local') {
      await this.k8s.deleteResource(
        kubeconfig,
        'EndpointSlice',
        names.forwardSlice,
        namespace,
      );
    }
    await this.k8s.deleteResource(
      kubeconfig,
      'Service',
      names.upstream,
      namespace,
    );
    const gone = Date.now() + SERVICE_GONE_MS;
    while (
      (await this.k8s
        .getResource(kubeconfig, 'Service', names.upstream, namespace)
        .catch(() => null)) &&
      Date.now() < gone
    ) {
      await this.sleep(PAUSE_POLL_MS);
    }
    try {
      await this.k8s.applyManifest(
        kubeconfig,
        dump(objects.service, { lineWidth: -1 }),
      );
    } catch (err) {
      await this.restoreUpstream(t, previous).catch((e: unknown) =>
        this.logger.error(
          `[pooler-cut] upstream of ${t.app.slug} not restored: ${messageOf(e)}`,
        ),
      );
      throw err;
    }
    if (objects.slice) {
      await this.k8s.applyManifest(
        kubeconfig,
        dump(objects.slice, { lineWidth: -1 }),
      );
    }
    await this.apps.update(t.app.id, { pooler: next } as never);
    t.app.pooler = next;
    if (upstream.mode === 'local') await this.awaitLocalEndpoints(t);
  }

  async dropForwardEgress(t: PoolerTarget, linkId: string): Promise<string[]> {
    const name = physicalNames(linkId).fwdNetpol;
    try {
      await this.k8s.deleteResource(
        t.db.kubeconfig,
        'NetworkPolicy',
        name,
        t.db.namespace,
      );
      return [];
    } catch (e) {
      return [`${name} not removed: ${messageOf(e)}`];
    }
  }

  private async restoreUpstream(
    t: PoolerTarget,
    spec: PoolerSpec,
  ): Promise<void> {
    const objects = poolerUpstreamObjects(t.app, spec);
    for (const obj of [objects.service, objects.slice]) {
      if (!obj) continue;
      await this.k8s.applyManifest(
        t.db.kubeconfig,
        dump(obj, { lineWidth: -1 }),
      );
    }
  }

  private async awaitLocalEndpoints(t: PoolerTarget): Promise<void> {
    const names = poolerNames(t.app.slug);
    const podIp = await this.pods.dbPodIp(t);
    const deadline = Date.now() + PROBE_WINDOW_MS;
    for (;;) {
      const slices = await this.k8s
        .listResourcesByLabel(
          t.db.kubeconfig,
          'EndpointSlice',
          t.db.namespace,
          `kubernetes.io/service-name=${names.upstream}`,
        )
        .catch(() => [] as any[]);
      const ours = slices.some(
        (s) =>
          s?.metadata?.labels?.['endpointslice.kubernetes.io/managed-by'] ===
          'flui-cloud',
      );
      const ready = slices.some((s) =>
        (s?.endpoints ?? []).some(
          (e: any) =>
            e?.conditions?.ready !== false &&
            (!podIp || (e?.addresses ?? []).includes(podIp)),
        ),
      );
      if (!ours && ready) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `The pooler upstream of ${t.app.slug} does not list its database pod yet`,
        );
      }
      await this.sleep(PAUSE_POLL_MS);
    }
  }
}
