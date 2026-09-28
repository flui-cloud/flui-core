export const SUC_NAMESPACE = 'system-upgrade';
export const SUC_DEPLOYMENT = 'system-upgrade-controller';
export const SUC_SERVICE_ACCOUNT = 'system-upgrade';
export const PLAN_CRD = 'plans.upgrade.cattle.io';
export const SERVER_PLAN = 'flui-k3s-server';
export const AGENT_PLAN = 'flui-k3s-agent';
export const K3S_UPGRADE_IMAGE = 'rancher/k3s-upgrade';
export const AGENT_DRAIN_TIMEOUT = '10m';
export const K3S_STEP_BASE_MS = 10 * 60_000;
export const K3S_STEP_PER_NODE_MS = 20 * 60_000;
export const K3S_CONTROLLER_WAIT_MS = 10 * 60_000;

const PROVENANCE = {
  'app.kubernetes.io/managed-by': 'flui-cloud',
  'flui.cloud/managed': 'true',
  'flui.cloud/scope': 'system',
  'flui.cloud/owner-kind': 'platform',
  'flui.cloud/owner-id': 'flui-core',
};

const CONTROL_PLANE = 'node-role.kubernetes.io/control-plane';

export interface K3sPlan {
  apiVersion: 'upgrade.cattle.io/v1';
  kind: 'Plan';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: Record<string, unknown>;
}

/**
 * The two Plans that move a cluster to one K3s version.
 *
 * The server is cordoned and never drained: on a one-server cluster a drain
 * would evict the API and the database it serves and could not finish. Agents
 * wait for the server (`prepare`), then go one at a time, drained. The
 * controller turns the `+` of the version into the `-` of the image tag.
 */
export function k3sPlans(version: string): [K3sPlan, K3sPlan] {
  const plan = (name: string, spec: Record<string, unknown>): K3sPlan => ({
    apiVersion: 'upgrade.cattle.io/v1',
    kind: 'Plan',
    metadata: {
      name,
      namespace: SUC_NAMESPACE,
      labels: { ...PROVENANCE, 'flui.cloud/k3s-upgrade': 'true' },
    },
    spec: {
      concurrency: 1,
      version,
      serviceAccountName: SUC_SERVICE_ACCOUNT,
      ...spec,
      upgrade: { image: K3S_UPGRADE_IMAGE },
    },
  });
  return [
    plan(SERVER_PLAN, {
      nodeSelector: {
        matchExpressions: [
          { key: CONTROL_PLANE, operator: 'In', values: ['true'] },
        ],
      },
      tolerations: [
        { key: CONTROL_PLANE, operator: 'Exists', effect: 'NoSchedule' },
        {
          key: 'node-role.kubernetes.io/master',
          operator: 'Exists',
          effect: 'NoSchedule',
        },
        { key: 'CriticalAddonsOnly', operator: 'Exists' },
      ],
      cordon: true,
    }),
    plan(AGENT_PLAN, {
      nodeSelector: {
        matchExpressions: [{ key: CONTROL_PLANE, operator: 'DoesNotExist' }],
      },
      prepare: { image: K3S_UPGRADE_IMAGE, args: ['prepare', SERVER_PLAN] },
      cordon: true,
      drain: {
        force: true,
        ignoreDaemonSets: true,
        deleteEmptydirData: true,
        timeout: AGENT_DRAIN_TIMEOUT,
      },
    }),
  ];
}

/** How the controller labels the jobs of a version: label values carry no `+`. */
export function jobVersionLabel(version: string): string {
  return version.replaceAll('+', '-');
}
