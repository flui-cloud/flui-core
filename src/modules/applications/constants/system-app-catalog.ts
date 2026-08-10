import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';

export interface SystemAppResourceDef {
  kind: ApplicationResourceKind;
  name: string;
  apiVersion: string;
}

export type SystemAppRegistry = 'ghcr' | 'dockerhub';

export interface SystemAppImageSource {
  registry: SystemAppRegistry;
  repository: string;
  containerName: string;
  deploymentName?: string;
  /**
   * Glob patterns of versions deployable through Flui. Curated to prevent
   * accidental upgrades across breaking-change boundaries (major bumps,
   * config schema changes, DB migrations).
   *
   * Examples:
   *   ['v4.*']        — only v4.x.x (any minor/patch, including pre-release)
   *   ['15.*']        — only 15.x.x
   *   ['12.*','13.*'] — both major 12 and 13 allowed (multi-major support)
   *   ['v4.15.*']     — only patches of 4.15
   *   ['*']           — any semver tag (M.m.p), excludes 'latest'/branch/sha
   *   ['**']          — any tag at all, including 'latest', branches, sha tags
   *
   * If omitted, the version picker is empty and direct deploys are blocked.
   */
  allowedVersions?: string[];
}

export interface SystemAppDefinition {
  name: string;
  k8sAppLabel: string;
  k8sNamespace: string;
  sourceType: ApplicationSourceType;
  clusterTypes: Array<'observability' | 'workload'>;
  primaryResourceKind: ApplicationResourceKind;
  expectedResources: SystemAppResourceDef[];
  description: string;
  port?: number;
  imageSource?: SystemAppImageSource;
  /**
   * How the app is actually reached on the cluster. Declared, never inferred:
   * the discovery path has no way to tell a ClusterIP-only datastore from a
   * front door, and defaulting everything to `public` labels the platform's own
   * Postgres and Redis as internet-facing when the firewall drops every port
   * they could be reached on. Omitted means `cluster` — ClusterIP only.
   */
  exposure?: ApplicationExposure;
}

export function findSystemAppByLabel(
  k8sAppLabel: string,
): SystemAppDefinition | undefined {
  return SYSTEM_APP_CATALOG.find((d) => d.k8sAppLabel === k8sAppLabel);
}

export const SYSTEM_APP_CATALOG: SystemAppDefinition[] = [
  {
    name: 'PostgreSQL',
    k8sAppLabel: 'postgres',
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.STATEFUL_SET,
    expectedResources: [
      {
        kind: ApplicationResourceKind.STATEFUL_SET,
        name: 'postgres',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'postgres',
        apiVersion: 'v1',
      },
      {
        kind: ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
        name: 'postgres-data',
        apiVersion: 'v1',
      },
    ],
    description: 'PostgreSQL database for Flui observability stack',
    imageSource: {
      registry: 'dockerhub',
      repository: 'library/postgres',
      containerName: 'postgres',
      allowedVersions: ['15.*'],
    },
  },
  {
    name: 'Redis',
    k8sAppLabel: 'redis',
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'redis',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'redis',
        apiVersion: 'v1',
      },
    ],
    description: 'Redis cache for Flui API',
    imageSource: {
      registry: 'dockerhub',
      repository: 'library/redis',
      containerName: 'redis',
      allowedVersions: ['7.*'],
    },
  },
  {
    name: 'VictoriaMetrics',
    k8sAppLabel: 'vmsingle',
    k8sNamespace: 'flui-control',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'vmsingle',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'vmsingle',
        apiVersion: 'v1',
      },
    ],
    description: 'VictoriaMetrics single-node TSDB and remote_write receiver',
    imageSource: {
      registry: 'dockerhub',
      repository: 'victoriametrics/victoria-metrics',
      containerName: 'vmsingle',
      allowedVersions: ['v1.*'],
    },
  },
  {
    name: 'vmagent',
    k8sAppLabel: 'vmagent',
    k8sNamespace: 'flui-control',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'vmagent',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.CONFIG_MAP,
        name: 'vmagent-config',
        apiVersion: 'v1',
      },
    ],
    description:
      'vmagent scraper that pushes metrics to vmsingle via remote_write',
    imageSource: {
      registry: 'dockerhub',
      repository: 'victoriametrics/vmagent',
      containerName: 'vmagent',
      allowedVersions: ['v1.*'],
    },
  },
  {
    name: 'vmalert',
    k8sAppLabel: 'vmalert',
    k8sNamespace: 'flui-control',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'vmalert',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.CONFIG_MAP,
        name: 'vmalert-rules',
        apiVersion: 'v1',
      },
    ],
    description:
      'vmalert evaluates recording rules and writes results back to vmsingle',
    imageSource: {
      registry: 'dockerhub',
      repository: 'victoriametrics/vmalert',
      containerName: 'vmalert',
      allowedVersions: ['v1.*'],
    },
  },
  {
    name: 'Loki',
    k8sAppLabel: 'loki',
    k8sNamespace: 'flui-control',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'loki',
        apiVersion: 'apps/v1',
      },
      { kind: ApplicationResourceKind.SERVICE, name: 'loki', apiVersion: 'v1' },
      {
        kind: ApplicationResourceKind.CONFIG_MAP,
        name: 'loki-config',
        apiVersion: 'v1',
      },
    ],
    description: 'Loki log aggregation',
    imageSource: {
      registry: 'dockerhub',
      repository: 'grafana/loki',
      containerName: 'loki',
      allowedVersions: ['3.*'],
    },
  },
  {
    name: 'Grafana',
    k8sAppLabel: 'grafana',
    k8sNamespace: 'flui-control',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'grafana',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'grafana',
        apiVersion: 'v1',
      },
      {
        kind: ApplicationResourceKind.CONFIG_MAP,
        name: 'grafana-datasources',
        apiVersion: 'v1',
      },
    ],
    description: 'Grafana dashboards and visualization',
    imageSource: {
      registry: 'dockerhub',
      repository: 'grafana/grafana',
      containerName: 'grafana',
      allowedVersions: ['13.*', '12.*'],
    },
  },
  {
    name: 'Flui API',
    k8sAppLabel: 'flui-api',
    exposure: ApplicationExposure.PUBLIC,
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'flui-api',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'flui-api',
        apiVersion: 'v1',
      },
    ],
    description: 'Flui cloud management API',
    port: 3000,
    imageSource: {
      registry: 'ghcr',
      repository: 'flui-cloud/core',
      containerName: 'flui-api',
      allowedVersions: ['**'],
    },
  },
  {
    name: 'Flui Web',
    k8sAppLabel: 'flui-web',
    exposure: ApplicationExposure.PUBLIC,
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'flui-web',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'flui-web',
        apiVersion: 'v1',
      },
      {
        kind: ApplicationResourceKind.CONFIG_MAP,
        name: 'flui-web-config',
        apiVersion: 'v1',
      },
    ],
    description: 'Flui web dashboard',
    port: 80,
    imageSource: {
      registry: 'ghcr',
      repository: 'flui-cloud/dashboard',
      containerName: 'flui-web',
      allowedVersions: ['**'],
    },
  },
  {
    name: 'Zitadel',
    k8sAppLabel: 'zitadel',
    exposure: ApplicationExposure.PUBLIC,
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'zitadel',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'zitadel',
        apiVersion: 'v1',
      },
      {
        kind: ApplicationResourceKind.CONFIG_MAP,
        name: 'zitadel-config',
        apiVersion: 'v1',
      },
      {
        kind: ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
        name: 'zitadel-bootstrap-pvc',
        apiVersion: 'v1',
      },
    ],
    description: 'Identity provider and OIDC server',
    port: 8080,
    imageSource: {
      registry: 'ghcr',
      repository: 'zitadel/zitadel',
      containerName: 'zitadel',
      allowedVersions: ['v4.*'],
    },
  },
  {
    name: 'Zitadel Login UI',
    k8sAppLabel: 'zitadel-login',
    exposure: ApplicationExposure.PUBLIC,
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['observability'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'zitadel-login',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'zitadel-login',
        apiVersion: 'v1',
      },
    ],
    description: 'Next.js login UI for Zitadel v4',
    port: 3000,
  },
  {
    name: 'Flui Authz',
    k8sAppLabel: 'flui-authz',
    k8sNamespace: 'flui-system',
    sourceType: ApplicationSourceType.RAW_MANIFEST,
    clusterTypes: ['workload'],
    primaryResourceKind: ApplicationResourceKind.DEPLOYMENT,
    expectedResources: [
      {
        kind: ApplicationResourceKind.DEPLOYMENT,
        name: 'flui-authz',
        apiVersion: 'apps/v1',
      },
      {
        kind: ApplicationResourceKind.SERVICE,
        name: 'flui-authz',
        apiVersion: 'v1',
      },
    ],
    description: 'In-cluster JWT validator for Traefik ForwardAuth',
    port: 8080,
    imageSource: {
      registry: 'ghcr',
      repository: 'flui-cloud/flui-authz',
      containerName: 'flui-authz',
      allowedVersions: ['**'],
    },
  },
];
