import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { withTimeout } from '../../infrastructure/shared/utils/with-timeout.util';
import { nodeRoomInputs } from '../../infrastructure/scaling/engine/room-inputs';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { validateApps } from '../utils/topology-validation.util';
import { workloadReferences } from '../utils/topology-workload-refs.util';
import { WorkloadRefs } from '../utils/topology-links.util';
import {
  ClusterContext,
  FLUI_MANAGED_LABEL_SELECTOR,
  LIST_PAGE_SIZE,
  WorkloadConfig,
  buildAppDto,
  describeDaemonSet,
  describeDeployment,
  describeStatefulSet,
  listAll,
  mapNodesToServers,
} from './topology-k8s.helper';
import {
  ClusterPart,
  applyCapacity,
  podMatchesSelector,
} from './topology-assembly.util';

const USAGE_EVERY_MS = 30_000;
const USAGE_TIMEOUT_MS = 6_000;
/** Config maps change with a deploy; read again after this. */
const CONFIG_MAP_EVERY_MS = 5 * 60_000;
const [MANAGED_BY_LABEL, MANAGED_BY_FLUI] =
  FLUI_MANAGED_LABEL_SELECTOR.split('=');

type NodeUsage = Map<string, { cpuMillicores: number; memoryMi: number }>;

/** Reads one cluster's state, a page at a time, with what it reads rarely kept a while. */
@Injectable()
export class TopologyClusterReader {
  private readonly logger = new Logger(TopologyClusterReader.name);
  private readonly usage = new Map<
    string,
    { at: number; nodes: NodeUsage | null }
  >();
  private readonly configMaps = new Map<
    string,
    { at: number; data: Record<string, string> }
  >();

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /** One cluster read: servers, workloads and the hosts their configuration names. */
  async read(
    cluster: ClusterEntity,
    ctx: ClusterContext,
  ): Promise<ClusterPart> {
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const { coreApi, appsApi } =
      this.kubernetesService.getKubeClient(kubeconfig);
    const page = {
      labelSelector: FLUI_MANAGED_LABEL_SELECTOR,
      limit: LIST_PAGE_SIZE,
    };
    const [nodes, deployments, statefulSets, daemonSets, pods, usage] =
      await Promise.all([
        listAll((next) =>
          coreApi.listNode({ limit: LIST_PAGE_SIZE, _continue: next }),
        ),
        listAll((next) =>
          appsApi.listDeploymentForAllNamespaces({ ...page, _continue: next }),
        ),
        listAll((next) =>
          appsApi.listStatefulSetForAllNamespaces({ ...page, _continue: next }),
        ),
        listAll((next) =>
          appsApi.listDaemonSetForAllNamespaces({ ...page, _continue: next }),
        ),
        listAll((next) =>
          coreApi.listPodForAllNamespaces({
            fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
            limit: LIST_PAGE_SIZE,
            _continue: next,
          }),
        ),
        this.nodeUsage(cluster.id, kubeconfig),
      ]);

    const managed = pods.filter(
      (p) => p.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_FLUI,
    );
    const servers = mapNodesToServers(nodes, ctx);
    applyCapacity(
      servers,
      nodeRoomInputs(nodes, pods, usage, this.kubernetesService),
    );
    const workloads = [
      ...deployments.map(describeDeployment),
      ...statefulSets.map(describeStatefulSet),
      ...daemonSets.map(describeDaemonSet),
    ];
    const refs = await this.workloadRefs(cluster.id, coreApi, workloads);
    const built = workloads.map((workload) =>
      buildAppDto(
        workload,
        managed.filter(
          (p) =>
            p.metadata?.namespace === workload.namespace &&
            podMatchesSelector(p, workload.selectorMatchLabels),
        ),
        servers,
        cluster.id,
      ),
    );
    const { apps, dropped } = validateApps(
      built,
      new Set(servers.map((s) => s.id)),
      cluster.id,
    );
    for (const server of servers) {
      server.podCount = apps.reduce(
        (sum, a) =>
          sum + (a.replicas.find((r) => r.serverId === server.id)?.count ?? 0),
        0,
      );
    }
    return { cluster, reached: true, servers, apps, dropped, refs };
  }

  /**
   * The hosts each workload's configuration names, from its plain values and
   * the config maps it loads. Config maps are read one by one, only those
   * named, and kept five minutes: they change with a deploy, not every poll.
   */
  private async workloadRefs(
    clusterId: string,
    coreApi: k8s.CoreV1Api,
    workloads: { name: string; namespace: string; config: WorkloadConfig }[],
  ): Promise<WorkloadRefs[]> {
    const wanted = new Set(
      workloads.flatMap((w) => [
        ...w.config.configMaps.map((n) => `${w.namespace}/${n}`),
        ...w.config.configMapKeys.map((k) => `${w.namespace}/${k.name}`),
      ]),
    );
    const data = new Map<string, Record<string, string>>();
    // One at a time: a handful of small reads, cached, and gentler on a slow link than a burst.
    for (const key of wanted) {
      data.set(key, await this.configMap(clusterId, coreApi, key));
    }
    return workloads.map((w) => {
      const entries = [
        ...w.config.entries,
        ...w.config.configMaps.flatMap((n) =>
          Object.entries(data.get(`${w.namespace}/${n}`) ?? {}).map(
            ([key, value]) => ({ key, value }),
          ),
        ),
        ...w.config.configMapKeys.flatMap((k) => {
          const value = data.get(`${w.namespace}/${k.name}`)?.[k.key];
          return value === undefined ? [] : [{ key: k.as, value }];
        }),
      ];
      return {
        namespace: w.namespace,
        name: w.name,
        refs: workloadReferences(entries, w.namespace),
      };
    });
  }

  private async configMap(
    clusterId: string,
    coreApi: k8s.CoreV1Api,
    key: string,
  ): Promise<Record<string, string>> {
    const cacheKey = `${clusterId}|${key}`;
    const cached = this.configMaps.get(cacheKey);
    if (cached && Date.now() - cached.at < CONFIG_MAP_EVERY_MS)
      return cached.data;
    const [namespace, name] = key.split('/');
    const data = await coreApi
      .readNamespacedConfigMap({ name, namespace })
      .then((cm) => cm.data ?? {})
      .catch((err: Error) => {
        if (!cached) {
          this.logger.warn(
            `Config map ${key} on ${clusterId} unreadable: ${err.message}`,
          );
        }
        return {};
      });
    this.configMaps.set(cacheKey, { at: Date.now(), data });
    return data;
  }

  /** Read at most every 30 s: the stream sends capacity on that rhythm. */
  private async nodeUsage(
    clusterId: string,
    kubeconfig: string,
  ): Promise<NodeUsage | null> {
    const cached = this.usage.get(clusterId);
    if (cached && Date.now() - cached.at < USAGE_EVERY_MS) return cached.nodes;
    const metrics = await withTimeout(
      new k8s.Metrics(
        this.kubernetesService.makeKubeConfig(kubeconfig),
      ).getNodeMetrics(),
      USAGE_TIMEOUT_MS,
    );
    const nodes = metrics
      ? new Map(
          (metrics.items ?? []).map((item) => [
            item.metadata?.name ?? '',
            {
              cpuMillicores: this.kubernetesService.parseCpu(
                item.usage?.cpu ?? '0',
              ),
              memoryMi: this.kubernetesService.parseMemory(
                item.usage?.memory ?? '0',
              ),
            },
          ]),
        )
      : null;
    this.usage.set(clusterId, { at: Date.now(), nodes });
    return nodes;
  }
}
