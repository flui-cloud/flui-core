import { ClusterType } from '../../clusters/entities/cluster.entity';

export type PlatformComponentKind =
  | 'Deployment'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'Service';

export interface PlatformComponentResourceDefinition {
  kind: PlatformComponentKind;
  name: string;
  namespace: string;
  workload?: boolean;
  optional?: boolean;
}

export interface PlatformComponentDefinition {
  key: string;
  name: string;
  description: string;
  category:
    | 'control-plane'
    | 'observability'
    | 'security'
    | 'networking'
    | 'storage'
    | 'core';
  managedBy: 'flui' | 'k3s' | 'addon';
  clusterTypes: ClusterType[];
  resources: PlatformComponentResourceDefinition[];
  /** If set, component is only included when the cluster authMode matches this value */
  requiredAuthMode?: 'local' | 'oidc';
  /** If true, component is only included when flui-authz is installed (RUNNING) on this cluster */
  requiredAuthzInstall?: boolean;
}

export const PLATFORM_COMPONENTS_CATALOG: PlatformComponentDefinition[] = [
  {
    key: 'flui-api',
    name: 'Flui API',
    description: 'Control plane API service',
    category: 'control-plane',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'flui-api',
        namespace: 'flui-system',
        workload: true,
      },
      { kind: 'Service', name: 'flui-api', namespace: 'flui-system' },
    ],
  },
  {
    key: 'flui-web',
    name: 'Flui Web',
    description: 'Control plane dashboard frontend',
    category: 'control-plane',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'flui-web',
        namespace: 'flui-system',
        workload: true,
      },
      { kind: 'Service', name: 'flui-web', namespace: 'flui-system' },
    ],
  },
  {
    key: 'zitadel',
    name: 'Zitadel',
    description: 'Identity provider and OIDC server',
    category: 'security',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    requiredAuthMode: 'oidc',
    resources: [
      {
        kind: 'Deployment',
        name: 'zitadel',
        namespace: 'flui-system',
        workload: true,
      },
      { kind: 'Service', name: 'zitadel', namespace: 'flui-system' },
    ],
  },
  {
    key: 'grafana',
    name: 'Grafana',
    description: 'Metrics and logs visualization',
    category: 'observability',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'grafana',
        namespace: 'flui-control',
        workload: true,
      },
      { kind: 'Service', name: 'grafana', namespace: 'flui-control' },
    ],
  },
  {
    key: 'vmsingle',
    name: 'VictoriaMetrics',
    description: 'Single-node TSDB and remote_write receiver',
    category: 'observability',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'vmsingle',
        namespace: 'flui-control',
        workload: true,
      },
      { kind: 'Service', name: 'vmsingle', namespace: 'flui-control' },
    ],
  },
  {
    key: 'vmagent',
    name: 'vmagent',
    description: 'Metrics scraper that pushes to vmsingle via remote_write',
    category: 'observability',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'vmagent',
        namespace: 'flui-control',
        workload: true,
      },
    ],
  },
  {
    key: 'vmalert',
    name: 'vmalert',
    description: 'Evaluates recording/alerting rules against vmsingle',
    category: 'observability',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'vmalert',
        namespace: 'flui-control',
        workload: true,
        optional: true,
      },
    ],
  },
  {
    key: 'loki',
    name: 'Loki',
    description: 'Log aggregation backend',
    category: 'observability',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'loki',
        namespace: 'flui-control',
        workload: true,
      },
      { kind: 'Service', name: 'loki', namespace: 'flui-control' },
    ],
  },
  {
    key: 'postgres',
    name: 'PostgreSQL',
    description: 'Primary control plane database',
    category: 'control-plane',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'StatefulSet',
        name: 'postgres',
        namespace: 'flui-system',
        workload: true,
      },
      { kind: 'Service', name: 'postgres', namespace: 'flui-system' },
    ],
  },
  {
    key: 'redis',
    name: 'Redis',
    description: 'Cache and queue backend',
    category: 'control-plane',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'redis',
        namespace: 'flui-system',
        workload: true,
      },
      { kind: 'Service', name: 'redis', namespace: 'flui-system' },
    ],
  },
  {
    key: 'kube-state-metrics',
    name: 'kube-state-metrics',
    description: 'Cluster object metrics exporter',
    category: 'observability',
    managedBy: 'addon',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'kube-state-metrics',
        namespace: 'flui-control',
        workload: true,
      },
    ],
  },
  {
    key: 'cert-manager',
    name: 'cert-manager',
    description: 'Certificate lifecycle manager (ACME/issuers)',
    category: 'security',
    managedBy: 'addon',
    clusterTypes: [ClusterType.CONTROL, ClusterType.WORKLOAD],
    resources: [
      {
        kind: 'Deployment',
        name: 'cert-manager',
        namespace: 'cert-manager',
        workload: true,
      },
      {
        kind: 'Deployment',
        name: 'cert-manager-cainjector',
        namespace: 'cert-manager',
        workload: true,
      },
      {
        kind: 'Deployment',
        name: 'cert-manager-webhook',
        namespace: 'cert-manager',
        workload: true,
      },
      {
        kind: 'Deployment',
        name: 'cert-manager-webhook-hetzner',
        namespace: 'cert-manager',
        workload: true,
        optional: true,
      },
      {
        kind: 'Deployment',
        name: 'scaleway-certmanager-webhook',
        namespace: 'cert-manager',
        workload: true,
        optional: true,
      },
    ],
  },
  {
    key: 'traefik',
    name: 'Traefik',
    description: 'Ingress controller',
    category: 'networking',
    managedBy: 'k3s',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'DaemonSet',
        name: 'traefik',
        namespace: 'kube-system',
        workload: true,
      },
      { kind: 'Service', name: 'traefik', namespace: 'kube-system' },
    ],
  },
  {
    key: 'traefik',
    name: 'Traefik',
    description: 'Ingress controller',
    category: 'networking',
    managedBy: 'k3s',
    clusterTypes: [ClusterType.WORKLOAD],
    resources: [
      {
        kind: 'Deployment',
        name: 'traefik',
        namespace: 'kube-system',
        workload: true,
      },
      { kind: 'Service', name: 'traefik', namespace: 'kube-system' },
    ],
  },
  {
    key: 'coredns',
    name: 'CoreDNS',
    description: 'Cluster DNS service',
    category: 'core',
    managedBy: 'k3s',
    clusterTypes: [ClusterType.CONTROL, ClusterType.WORKLOAD],
    resources: [
      {
        kind: 'Deployment',
        name: 'coredns',
        namespace: 'kube-system',
        workload: true,
      },
    ],
  },
  {
    key: 'metrics-server',
    name: 'metrics-server',
    description: 'Resource metrics API for pods and nodes',
    category: 'core',
    managedBy: 'k3s',
    clusterTypes: [ClusterType.CONTROL, ClusterType.WORKLOAD],
    resources: [
      {
        kind: 'Deployment',
        name: 'metrics-server',
        namespace: 'kube-system',
        workload: true,
      },
    ],
  },
  {
    key: 'local-path-provisioner',
    name: 'local-path-provisioner',
    description: 'Default storage provisioner',
    category: 'storage',
    managedBy: 'k3s',
    clusterTypes: [ClusterType.CONTROL, ClusterType.WORKLOAD],
    resources: [
      {
        kind: 'Deployment',
        name: 'local-path-provisioner',
        namespace: 'kube-system',
        workload: true,
      },
    ],
  },
  {
    key: 'flui-local-path-provisioner',
    name: 'flui-local storage',
    description: 'Node-local storage provisioner for dedicated workloads',
    category: 'storage',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL],
    resources: [
      {
        kind: 'Deployment',
        name: 'flui-local-path-provisioner',
        namespace: 'flui-local-storage',
        workload: true,
      },
    ],
  },
  {
    key: 'flui-authz',
    name: 'Flui Authz',
    description: 'In-cluster JWT validator for Traefik ForwardAuth',
    category: 'security',
    managedBy: 'flui',
    clusterTypes: [ClusterType.CONTROL, ClusterType.WORKLOAD],
    requiredAuthMode: 'oidc',
    requiredAuthzInstall: true,
    resources: [
      {
        kind: 'Deployment',
        name: 'flui-authz',
        namespace: 'flui-system',
        workload: true,
      },
      { kind: 'Service', name: 'flui-authz', namespace: 'flui-system' },
    ],
  },
];
