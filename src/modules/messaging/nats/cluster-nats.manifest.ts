export const NATS_NAMESPACE = 'flui-system';
export const NATS_NAME = 'flui-nats';
// The alpine variant: the server fetches its accounts from the API over HTTPS,
// and the scratch image carries no certificate authorities to verify it with.
export const NATS_IMAGE = 'docker.io/library/nats:2.15-alpine';
export const NATS_CLIENT_PORT = 4222;
export const NATS_MONITOR_PORT = 8222;
const LABELS = {
  'managed-by': 'flui-cloud',
  'flui-resource-type': 'messaging',
};

/** Where an application in the cluster reaches the shared NATS. */
export const NATS_IN_CLUSTER_URL = `nats://${NATS_NAME}.${NATS_NAMESPACE}.svc.cluster.local:${NATS_CLIENT_PORT}`;

export interface ClusterNatsSettings {
  operatorJwt: string;
  systemAccount: string;
  /** Base of the account lookups, ending in a slash: the server appends an account's public key. */
  resolverUrl: string;
  storage: string;
}

/**
 * The server learns each account from Flui's API on first use, so nothing
 * secret is written here: an operator JWT and a URL. JetStream keeps its data
 * on the volume.
 */
export function natsConfig(s: ClusterNatsSettings): string {
  return [
    `port: ${NATS_CLIENT_PORT}`,
    `http: ${NATS_MONITOR_PORT}`,
    `operator: ${s.operatorJwt}`,
    `system_account: ${s.systemAccount}`,
    `resolver: URL(${s.resolverUrl})`,
    'jetstream {',
    '  store_dir: /data',
    '}',
    '',
  ].join('\n');
}

export function buildNatsConfigMap(s: ClusterNatsSettings): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: NATS_NAME, namespace: NATS_NAMESPACE, labels: LABELS },
    data: { 'nats.conf': natsConfig(s) },
  });
}

export function buildNatsService(): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: NATS_NAME, namespace: NATS_NAMESPACE, labels: LABELS },
    spec: {
      selector: { app: NATS_NAME },
      ports: [
        {
          name: 'client',
          port: NATS_CLIENT_PORT,
          targetPort: NATS_CLIENT_PORT,
        },
        {
          name: 'monitor',
          port: NATS_MONITOR_PORT,
          targetPort: NATS_MONITOR_PORT,
        },
      ],
    },
  });
}

/** A config hash on the pod template restarts the server when the configuration changes. */
export function buildNatsStatefulSet(
  s: ClusterNatsSettings,
  configHash: string,
): string {
  return JSON.stringify({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: NATS_NAME, namespace: NATS_NAMESPACE, labels: LABELS },
    spec: {
      serviceName: NATS_NAME,
      replicas: 1,
      selector: { matchLabels: { app: NATS_NAME } },
      template: {
        metadata: {
          labels: { app: NATS_NAME, ...LABELS },
          annotations: { 'flui.cloud/config-hash': configHash },
        },
        spec: {
          tolerations: [
            'node-role.kubernetes.io/control-plane',
            'node-role.kubernetes.io/master',
          ].map((key) => ({ key, operator: 'Exists', effect: 'NoSchedule' })),
          containers: [
            {
              name: 'nats',
              image: NATS_IMAGE,
              args: ['-c', '/etc/nats/nats.conf'],
              ports: [
                { name: 'client', containerPort: NATS_CLIENT_PORT },
                { name: 'monitor', containerPort: NATS_MONITOR_PORT },
              ],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '1', memory: '512Mi' },
              },
              readinessProbe: {
                httpGet: { path: '/healthz', port: NATS_MONITOR_PORT },
                periodSeconds: 10,
              },
              volumeMounts: [
                { name: 'config', mountPath: '/etc/nats' },
                { name: 'data', mountPath: '/data' },
              ],
            },
          ],
          volumes: [{ name: 'config', configMap: { name: NATS_NAME } }],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: 'data', labels: LABELS },
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: s.storage } },
          },
        },
      ],
    },
  });
}
