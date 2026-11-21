import { SandboxConfig } from '../sandbox.config';

export const NOTICE_NAMESPACE = 'flui-system';
export const NOTICE_NAME = 'flui-trial-notice';
export const NOTICE_KEY_SECRET = 'flui-trial-notice-key';
export const NOTICE_MIDDLEWARE_NAME = 'sandbox-notice';
const NOTICE_ADDRESS = `http://${NOTICE_NAME}.${NOTICE_NAMESPACE}.svc.cluster.local/trial-notice`;
const LABELS = {
  'managed-by': 'flui-cloud',
  'flui-resource-type': 'trial-notice',
};

export function sandboxNoticeMiddlewareRef(namespace: string): string {
  return `${namespace}-${NOTICE_MIDDLEWARE_NAME}@kubernetescrd`;
}

/**
 * Sends every request to a guest app past the notice first. The forwarded
 * headers are Traefik's own, never the client's: the host they name is the one
 * the visit cookie is signed for.
 */
export function buildNoticeMiddleware(namespace: string): string {
  return JSON.stringify({
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: { name: NOTICE_MIDDLEWARE_NAME, namespace, labels: LABELS },
    spec: {
      forwardAuth: { address: NOTICE_ADDRESS, trustForwardHeader: false },
    },
  });
}

export function buildNoticeKeySecret(key: string): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: NOTICE_KEY_SECRET,
      namespace: NOTICE_NAMESPACE,
      labels: LABELS,
    },
    type: 'Opaque',
    stringData: { key },
  });
}

export function buildNoticeService(): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: NOTICE_NAME,
      namespace: NOTICE_NAMESPACE,
      labels: LABELS,
    },
    spec: {
      selector: { app: NOTICE_NAME },
      ports: [{ port: 80, targetPort: 8080 }],
    },
  });
}

/**
 * Two replicas because every guest app waits on it: with none running, Traefik
 * refuses the guest apps rather than serving them without the notice.
 */
export function buildNoticeDeployment(
  image: string,
  notice: SandboxConfig['notice'],
  allowMasterPlacement: boolean,
): string {
  const env = [
    {
      name: 'NOTICE_KEY',
      valueFrom: { secretKeyRef: { name: NOTICE_KEY_SECRET, key: 'key' } },
    },
    { name: 'NOTICE_MINUTES', value: String(notice.minutes) },
    { name: 'NOTICE_TRY_URL', value: notice.tryUrl },
    ...(notice.abuseUrl
      ? [{ name: 'NOTICE_ABUSE_URL', value: notice.abuseUrl }]
      : []),
    { name: 'PORT', value: '8080' },
  ];
  return JSON.stringify({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: NOTICE_NAME,
      namespace: NOTICE_NAMESPACE,
      labels: LABELS,
    },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: NOTICE_NAME } },
      template: {
        metadata: { labels: { app: NOTICE_NAME, ...LABELS } },
        spec: {
          ...(allowMasterPlacement
            ? {
                tolerations: [
                  'node-role.kubernetes.io/control-plane',
                  'node-role.kubernetes.io/master',
                ].map((key) => ({
                  key,
                  operator: 'Exists',
                  effect: 'NoSchedule',
                })),
              }
            : {}),
          // The image runs as the named user `node`; Kubernetes can only check
          // a number against runAsNonRoot.
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
          },
          containers: [
            {
              name: NOTICE_NAME,
              image,
              ports: [{ containerPort: 8080 }],
              env,
              resources: {
                requests: { cpu: '10m', memory: '48Mi' },
                limits: { cpu: '200m', memory: '128Mi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              readinessProbe: {
                httpGet: { path: '/healthz', port: 8080 },
                initialDelaySeconds: 3,
                periodSeconds: 5,
              },
            },
          ],
        },
      },
    },
  });
}
