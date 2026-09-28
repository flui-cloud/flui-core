import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  CONTROL_CLUSTER_TYPES,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { MasterKind } from './bootstrap-files.service';
import { MasterAccess } from '../interfaces/install-values.interface';
import {
  INSTALL_VALUES_NAME,
  INSTALL_VALUES_NAMESPACE,
  INSTALL_VALUES_SCHEMA,
  ImageTagSlot,
  InstallRecord,
  parseInstallRecord,
  tagForSlot,
} from '../utils/install-values.util';
import { InstallTransforms } from '../utils/manifest-render.util';
import {
  WORKLOAD_INGEST_PORT,
  candidateValues,
  nonEmpty,
  parseWebConfig,
  remoteWriteOf,
  routeHostsOf,
} from '../utils/install-candidates.util';

const PROVENANCE_LABELS = {
  'app.kubernetes.io/managed-by': 'flui-cloud',
  'flui.cloud/managed': 'true',
  'flui.cloud/scope': 'system',
  'flui.cloud/owner-kind': 'platform',
  'flui.cloud/owner-id': 'flui-core',
};

export interface LiveConfig {
  apiConfig: Record<string, string>;
  webConfig: Record<string, unknown>;
  routeHosts: string[];
}

export interface ReconstructedRecord {
  bootstrapRef: string;
  values: Record<string, string>;
  secretRefs: Record<string, string[]>;
  transforms: InstallTransforms;
  rendered: Record<string, string>;
}

/**
 * What a running installation says about how it was built: the install record
 * it carries, the images and configuration it runs, and where its metrics go.
 */
@Injectable()
export class InstallStateService {
  private readonly logger = new Logger(InstallStateService.name);

  constructor(
    private readonly kubernetesService: KubernetesService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
  ) {}

  async recorded(kubeconfig: string): Promise<InstallRecord | null> {
    const configMap = await this.kubernetesService
      .readObject(
        kubeconfig,
        'v1',
        'ConfigMap',
        INSTALL_VALUES_NAME,
        INSTALL_VALUES_NAMESPACE,
      )
      .catch(() => null);
    return parseInstallRecord(configMap?.data, configMap?.metadata?.labels);
  }

  /** `Kind/name/container` → image, for workloads the documents declare. */
  async runningImages(
    kubeconfig: string,
    workloads: Array<{ kind: string; name: string; namespace: string }>,
  ): Promise<Map<string, string> | undefined> {
    const images = new Map<string, string>();
    try {
      for (const w of workloads) {
        const live = await this.kubernetesService.readObject(
          kubeconfig,
          'apps/v1',
          w.kind,
          w.name,
          w.namespace,
        );
        for (const c of live?.spec?.template?.spec?.containers ?? []) {
          if (typeof c?.image === 'string') {
            images.set(`${w.kind}/${w.name}/${c.name}`, c.image);
          }
        }
      }
      return images;
    } catch (error) {
      this.logger.warn(
        `Could not read running images: ${(error as Error).message}`,
      );
      return undefined;
    }
  }

  /** Where this cluster's metrics agent pushes, read from the agent itself. */
  async runningRemoteWrite(kubeconfig: string): Promise<string | null> {
    const live = await this.kubernetesService
      .readObject(
        kubeconfig,
        'apps/v1',
        'Deployment',
        'vmagent',
        'flui-monitoring',
      )
      .catch(() => null);
    return remoteWriteOf(live);
  }

  async runningTags(
    kubeconfig: string,
    slots: ImageTagSlot[],
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const seen = new Map<string, unknown>();
    for (const slot of slots) {
      if (out[slot.variable] !== undefined) continue;
      const key = `${slot.kind}/${slot.namespace}/${slot.name}`;
      if (!seen.has(key)) {
        seen.set(
          key,
          await this.kubernetesService
            .readObject(
              kubeconfig,
              'apps/v1',
              slot.kind,
              slot.name,
              slot.namespace,
            )
            .catch(() => null),
        );
      }
      const live = seen.get(key) as {
        spec?: { template?: { spec?: { containers?: any[] } } };
      } | null;
      const container = (live?.spec?.template?.spec?.containers ?? []).find(
        (c) => c?.name === slot.container,
      );
      const tag = tagForSlot(slot, container?.image);
      if (tag) out[slot.variable] = tag;
    }
    return out;
  }

  /** The API and web configuration and the hosts the IngressRoutes answer on. */
  async liveConfig(kubeconfig: string): Promise<LiveConfig> {
    const read = (kind: string, name: string, namespace: string) =>
      this.kubernetesService
        .readObject(kubeconfig, 'v1', kind, name, namespace)
        .catch(() => null);
    const apiConfig: Record<string, string> =
      (await read('ConfigMap', 'flui-api-config', 'flui-system'))?.data ?? {};
    const webConfig = parseWebConfig(
      (await read('ConfigMap', 'flui-web-config', 'flui-system'))?.data?.[
        'config.json'
      ],
    );
    const routes = await this.kubernetesService
      .listCrdResources(
        kubeconfig,
        'IngressRoute',
        'flui-system',
        'traefik.io/v1alpha1',
      )
      .catch(() => []);
    return { apiConfig, webConfig, routeHosts: routeHostsOf(routes) };
  }

  /** Where a workload cluster's agent may have been told to push at install. */
  async workloadRemoteWrites(kubeconfig: string): Promise<string[]> {
    const control = await this.clusterRepository
      .findOne({
        where: {
          clusterType: In([...CONTROL_CLUSTER_TYPES]),
        },
      })
      .catch(() => null);
    return nonEmpty([
      await this.runningRemoteWrite(kubeconfig),
      ...nonEmpty([control?.masterPrivateIp, control?.masterIpAddress]).map(
        (ip) => `http://${ip}:${WORKLOAD_INGEST_PORT}/api/v1/write`,
      ),
    ]);
  }

  async writeRecord(
    kubeconfig: string,
    kind: MasterKind,
    record: ReconstructedRecord,
  ): Promise<void> {
    const labels = {
      ...PROVENANCE_LABELS,
      'flui.cloud/install-values-source': 'reconstructed',
    };
    const data = {
      schema: INSTALL_VALUES_SCHEMA,
      bootstrapRef: record.bootstrapRef,
      releaseVersion: '',
      clusterType: kind,
      k3sVersion: '',
      'values.json': JSON.stringify(record.values),
      'secretRefs.json': JSON.stringify(record.secretRefs),
      'transforms.json': JSON.stringify(record.transforms),
      'rendered.json': JSON.stringify(record.rendered),
    };
    const existing = await this.kubernetesService.readObject(
      kubeconfig,
      'v1',
      'ConfigMap',
      INSTALL_VALUES_NAME,
      INSTALL_VALUES_NAMESPACE,
    );
    if (existing) {
      throw new ConflictException(
        'A record appeared on this installation while reconstructing; nothing was written over it.',
      );
    }
    await this.kubernetesService.createObject(kubeconfig, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: INSTALL_VALUES_NAME,
        namespace: INSTALL_VALUES_NAMESPACE,
        labels,
      },
      data,
    });
  }

  /**
   * Every value the master's files may have been rendered with, from what
   * Flui already knows and what the cluster runs.
   */
  async candidates(
    access: MasterAccess,
    running: Record<string, string>,
    secretVariables: ReadonlySet<string>,
  ): Promise<Record<string, string[]>> {
    const { cluster, kubeconfig, kind } = access;
    const live = await this.liveConfig(kubeconfig);
    return candidateValues({
      cluster,
      kind,
      env: kind === 'control' ? process.env : {},
      ...live,
      remoteWrites:
        kind === 'control' ? [] : await this.workloadRemoteWrites(kubeconfig),
      running,
      secretVariables,
    });
  }
}
