import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  CONSOLE_TARGET_ABSENT,
  platformFoundationAtTarget,
} from '../constants/platform-foundations';

export interface PortForwardTunnel {
  /** Loopback port a TCP client (e.g. a pg.Pool) connects to. */
  localPort: number;
  /**
   * Releases this caller's lease on the tunnel. The underlying loopback server
   * stays warm and is reused by the next request to the same target; it is torn
   * down only after {@link IDLE_TTL_MS} with no active leases.
   */
  dispose: () => Promise<void>;
}

interface PoolEntry {
  key: string;
  namespace: string;
  targetPort: number;
  podName: string;
  localPort: number;
  server: net.Server | null;
  pf: k8s.PortForward | null;
  sockets: Set<net.Socket>;
  /** Number of in-flight callers currently holding this tunnel. */
  leases: number;
  /** Fires once leases reach 0; closes the server after the idle window. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Removed from the pool (broken/over-cap) — drains existing leases, no reuse. */
  retired: boolean;
  /** Server closed; entry is dead. */
  closed: boolean;
  /** Resolves when the loopback server is listening; rejects if no pod. */
  ready: Promise<void>;
}

/** Keep a warm tunnel for this long after the last lease is released. */
const IDLE_TTL_MS = 60_000;
/** When the pool grows past this, sweep idle tunnels before opening a new one. */
const MAX_ENTRIES = 32;

/**
 * Opens a raw TCP tunnel from a loopback port on this process to an in-cluster
 * pod, via the Kubernetes apiserver `portforward` subresource. This is the only
 * way the control-plane backend can speak the Postgres wire protocol to a DB
 * running on a workload cluster (the apiserver's HTTP service-proxy cannot carry
 * arbitrary TCP). Reachability is inherited from the patched kubeconfig server,
 * exactly like exec/apply.
 *
 * Tunnels are pooled per (cluster, namespace, selector, port): a console session
 * fires many requests in quick succession (e.g. write -> re-list -> re-read), and
 * opening a fresh tunnel each time costs a `listNamespacedPod` round-trip plus a
 * loopback bind. `open()` hands out a lease over a shared, warm server; `dispose()`
 * only releases the lease. A tunnel is torn down on idle TTL, on a forward error
 * (self-healing when the pod is replaced), or on shutdown.
 */
@Injectable()
export class KubePortForwardService implements OnModuleDestroy {
  private readonly logger = new Logger(KubePortForwardService.name);
  private readonly pool = new Map<string, PoolEntry>();

  constructor(private readonly kubernetesService: KubernetesService) {}

  async open(
    kubeconfig: string,
    namespace: string,
    podLabelSelector: string,
    targetPort: number,
  ): Promise<PortForwardTunnel> {
    // Last of the three depths that close the platform's foundations, and the
    // only one that reads no name at all: whatever row asked, and whatever it
    // is called today, a console tunnel that would land on a foundation's port
    // inside a platform namespace does not open. See PLATFORM_FOUNDATIONS.
    const foundation = platformFoundationAtTarget(namespace, targetPort);
    if (foundation) {
      this.logger.warn(
        `Refused a console tunnel to the ${foundation.key} foundation (${namespace}:${targetPort})`,
      );
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    const key = this.keyFor(
      kubeconfig,
      namespace,
      podLabelSelector,
      targetPort,
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      let entry = this.pool.get(key);
      if (!entry) {
        if (this.pool.size >= MAX_ENTRIES) this.sweepIdle();
        entry = this.createEntry(
          key,
          kubeconfig,
          namespace,
          podLabelSelector,
          targetPort,
        );
        this.pool.set(key, entry);
      }

      // Acquire the lease before awaiting readiness so a concurrent open() (or a
      // slow build) can't let the idle timer tear the tunnel down underneath us.
      entry.leases++;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }

      try {
        await entry.ready;
      } catch (err) {
        entry.leases = Math.max(0, entry.leases - 1);
        if (this.pool.get(key) === entry) this.pool.delete(key);
        throw err;
      }

      if (entry.closed || entry.retired) {
        await this.release(entry);
        continue; // built tunnel went stale mid-flight — rebuild
      }

      const live = entry;
      return {
        localPort: live.localPort,
        dispose: () => this.release(live),
      };
    }

    this.logger.warn(
      `port-forward: tunnel for "${podLabelSelector}" in "${namespace}" kept going stale; pod may be unavailable`,
    );
    throw new NotFoundException(CONSOLE_TARGET_ABSENT);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pool.values()].map((e) => this.teardown(e)));
  }

  private keyFor(
    kubeconfig: string,
    namespace: string,
    selector: string,
    targetPort: number,
  ): string {
    const h = crypto
      .createHash('sha256')
      .update(kubeconfig)
      .digest('hex')
      .slice(0, 12);
    return `${namespace}|${selector}|${targetPort}|${h}`;
  }

  private createEntry(
    key: string,
    kubeconfig: string,
    namespace: string,
    selector: string,
    targetPort: number,
  ): PoolEntry {
    const entry: PoolEntry = {
      key,
      namespace,
      targetPort,
      podName: '',
      localPort: 0,
      server: null,
      pf: null,
      sockets: new Set<net.Socket>(),
      leases: 0,
      idleTimer: null,
      retired: false,
      closed: false,
      ready: Promise.resolve(),
    };
    entry.ready = this.build(entry, kubeconfig, selector);
    return entry;
  }

  private async build(
    entry: PoolEntry,
    kubeconfig: string,
    selector: string,
  ): Promise<void> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: entry.namespace,
      labelSelector: selector,
    });
    const pod = (pods.items ?? []).find((p) => p.status?.phase === 'Running');
    if (!pod?.metadata?.name) {
      // An absence, not a fault. `redis` answered 500 here because discovery
      // labels a bootstrap-created pod with nothing Flui coined: the selector
      // `flui-app-id=<uuid>` cannot match a pod the bootstrap made, so there is
      // simply no target — the same for an application scaled to zero. The
      // sentence is the one a missing application gets, so a caller learns
      // nothing about which of the two it hit.
      this.logger.warn(
        `No running pod for selector "${selector}" in namespace "${entry.namespace}"`,
      );
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }
    entry.podName = pod.metadata.name;

    const pf = new k8s.PortForward(kc, true);
    entry.pf = pf;

    const server = net.createServer((socket) => {
      if (entry.closed) {
        socket.destroy();
        return;
      }
      entry.sockets.add(socket);
      socket.on('close', () => entry.sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      // The incoming socket is both the sink (pod->client) and the source
      // (client->pod) of the forwarded stream.
      pf.portForward(
        entry.namespace,
        entry.podName,
        [entry.targetPort],
        socket,
        socket,
        socket,
      ).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `port-forward stream error for ${entry.podName}:${entry.targetPort}: ${reason}`,
        );
        socket.destroy();
        // A forward failure usually means the pod was replaced: retire the warm
        // tunnel so the next request rebuilds against the new pod.
        this.retire(entry, 'forward error');
      });
    });
    entry.server = server;
    server.on('error', (err) => {
      this.logger.warn(
        `port-forward server error for ${entry.namespace}/${entry.podName}:${entry.targetPort}: ${err.message}`,
      );
      this.retire(entry, 'server error');
    });

    entry.localPort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('failed to bind loopback port for port-forward'));
      });
    });

    this.logger.log(
      `port-forward pool: opened 127.0.0.1:${entry.localPort} -> ${entry.namespace}/${entry.podName}:${entry.targetPort}`,
    );
  }

  private async release(entry: PoolEntry): Promise<void> {
    if (entry.closed) return;
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases > 0) return;
    if (entry.retired) {
      await this.teardown(entry);
      return;
    }
    if (!entry.idleTimer) {
      entry.idleTimer = setTimeout(() => {
        void this.evictIdle(entry);
      }, IDLE_TTL_MS);
      entry.idleTimer.unref?.();
    }
  }

  /** Remove from the pool but let in-flight leases drain before teardown. */
  private retire(entry: PoolEntry, reason: string): void {
    if (entry.closed || entry.retired) return;
    entry.retired = true;
    if (this.pool.get(entry.key) === entry) this.pool.delete(entry.key);
    this.logger.warn(
      `port-forward pool: retired tunnel for ${entry.namespace}/${entry.podName}:${entry.targetPort} (${reason})`,
    );
    if (entry.leases === 0) void this.teardown(entry);
  }

  private async evictIdle(entry: PoolEntry): Promise<void> {
    if (entry.closed || entry.leases > 0) return;
    await this.teardown(entry);
    this.logger.log(
      `port-forward pool: evicted idle 127.0.0.1:${entry.localPort} -> ${entry.namespace}/${entry.podName}:${entry.targetPort}`,
    );
  }

  private sweepIdle(): void {
    for (const entry of this.pool.values()) {
      if (entry.leases === 0 && !entry.retired && !entry.closed) {
        void this.evictIdle(entry);
      }
    }
  }

  private async teardown(entry: PoolEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (this.pool.get(entry.key) === entry) this.pool.delete(entry.key);
    for (const s of entry.sockets) s.destroy();
    entry.sockets.clear();
    const server = entry.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
