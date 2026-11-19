import { TOPOLOGY_ZONE_LABEL } from '../../providers/core/node-topology';
import { ResourcePair } from '../../shared/utils/resource-quantity.util';
import {
  CNPG_API_VERSION,
  CNPG_POSTGRES_IMAGE,
  CNPG_PRIMARY_UPDATE_METHOD,
} from '../postgres-ha.constants';

/**
 * `required`: with no copy able to confirm, writes wait (integrity first).
 * `preferred`: writes go on alone and the copy catches up (availability first).
 */
export type PostgresHaDurability = 'required' | 'preferred';

export interface CnpgClusterInput {
  name: string;
  namespace: string;
  appId: string;
  instances: number;
  /** Where the primary belongs: the locations close enough to confirm a write together. */
  preferredZones: string[];
  durability: PostgresHaDurability;
  storageClass: string;
  sizeGi: number;
  database: string;
  owner: string;
  credentialsSecret: string;
  imageName?: string;
  /** The single instance's requests and limits, carried over as they are. */
  resources?: ResourcePair;
}

/** The operator's own exporter; the cluster's metrics agent collects what carries these. */
const METRICS_ANNOTATIONS = {
  'prometheus.io/scrape': 'true',
  'prometheus.io/port': '9187',
  'prometheus.io/path': '/metrics',
};

export function renderCnpgCluster(
  input: CnpgClusterInput,
): Record<string, unknown> {
  if (input.instances < 2) {
    throw new Error('A highly available Postgres needs at least two instances');
  }
  const labels = {
    'flui-app-id': input.appId,
    'flui.cloud/db-engine': 'postgres',
    'flui.cloud/managed-by': 'flui-cloud',
  };
  // One instance per location. The first one is placed first and becomes the
  // primary, so the preference puts it, and its closest copy, where writes
  // are confirmed fastest.
  const affinity = {
    enablePodAntiAffinity: true,
    podAntiAffinityType: 'required',
    topologyKey: TOPOLOGY_ZONE_LABEL,
    nodeAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 100,
          preference: {
            matchExpressions: [
              {
                key: TOPOLOGY_ZONE_LABEL,
                operator: 'In',
                values: input.preferredZones,
              },
            ],
          },
        },
      ],
    },
  };
  return {
    apiVersion: CNPG_API_VERSION,
    kind: 'Cluster',
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      instances: input.instances,
      imageName: input.imageName ?? CNPG_POSTGRES_IMAGE,
      primaryUpdateStrategy: 'unsupervised',
      primaryUpdateMethod: CNPG_PRIMARY_UPDATE_METHOD,
      inheritedMetadata: { labels, annotations: METRICS_ANNOTATIONS },
      storage: { storageClass: input.storageClass, size: `${input.sizeGi}Gi` },
      bootstrap: {
        initdb: {
          database: input.database,
          owner: input.owner,
          secret: { name: input.credentialsSecret },
        },
      },
      postgresql: {
        // A commit waits for whichever copy answers first, the close one in
        // practice; the far one only when the close one is away.
        synchronous: {
          method: 'any',
          number: 1,
          dataDurability: input.durability,
          failoverQuorum: true,
        },
      },
      affinity,
      ...(input.resources && { resources: input.resources }),
    },
  };
}

/** The owner credentials in the shape the operator reads at first start. */
export function renderCnpgCredentials(input: {
  name: string;
  namespace: string;
  appId: string;
  username: string;
  password: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/basic-auth',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: {
        'flui-app-id': input.appId,
        'flui.cloud/managed-by': 'flui-cloud',
      },
    },
    stringData: { username: input.username, password: input.password },
  };
}
