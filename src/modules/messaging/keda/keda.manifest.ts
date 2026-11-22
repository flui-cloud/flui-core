import {
  NATS_MONITOR_PORT,
  NATS_NAME,
  NATS_NAMESPACE,
} from '../nats/cluster-nats.manifest';

export const KEDA_CHART_VERSION = process.env.KEDA_CHART_VERSION ?? '2.21.1';
export const KEDA_NAMESPACE = 'keda';

/**
 * KEDA through k3s' own Helm controller: the cluster installs and upgrades
 * the chart itself, at the pinned version, without a Helm client anywhere.
 */
export function buildKedaHelmChart(
  version: string = KEDA_CHART_VERSION,
): string {
  return JSON.stringify({
    apiVersion: 'helm.cattle.io/v1',
    kind: 'HelmChart',
    metadata: {
      name: 'keda',
      namespace: 'kube-system',
      labels: { 'managed-by': 'flui-cloud' },
    },
    spec: {
      repo: 'https://kedacore.github.io/charts',
      chart: 'keda',
      version,
      targetNamespace: KEDA_NAMESPACE,
      createNamespace: true,
    },
  });
}

export interface QueueScaling {
  /** The Deployment KEDA scales: the application's own. */
  deployment: string;
  namespace: string;
  /** Public key of the application's NATS account, which KEDA matches as the account id. */
  account: string;
  stream: string;
  consumer: string;
  /** Messages waiting per replica before another one is added. */
  lagThreshold: number;
  minReplicas: number;
  maxReplicas: number;
}

/**
 * Scales a worker on the messages its consumer has not handled yet, down to
 * none while the queue is empty. KEDA owns the replica count from then on.
 */
export function buildQueueScaledObject(q: QueueScaling): string {
  return JSON.stringify({
    apiVersion: 'keda.sh/v1alpha1',
    kind: 'ScaledObject',
    metadata: {
      name: `${q.deployment}-queue`,
      namespace: q.namespace,
      labels: { 'managed-by': 'flui-cloud' },
    },
    spec: {
      scaleTargetRef: { name: q.deployment },
      minReplicaCount: q.minReplicas,
      maxReplicaCount: q.maxReplicas,
      pollingInterval: 15,
      cooldownPeriod: 300,
      triggers: [
        {
          type: 'nats-jetstream',
          metadata: {
            natsServerMonitoringEndpoint: `${NATS_NAME}.${NATS_NAMESPACE}.svc.cluster.local:${NATS_MONITOR_PORT}`,
            accountID: q.account,
            stream: q.stream,
            consumer: q.consumer,
            lagThreshold: String(q.lagThreshold),
            activationLagThreshold: '0',
          },
        },
      ],
    },
  });
}
