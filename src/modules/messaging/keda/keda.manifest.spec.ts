import { buildKedaHelmChart, buildQueueScaledObject } from './keda.manifest';

describe('workers that scale on their queue', () => {
  it('has the cluster install KEDA at a pinned version through its own Helm controller', () => {
    const chart = JSON.parse(buildKedaHelmChart('2.21.1'));
    expect(chart).toMatchObject({
      apiVersion: 'helm.cattle.io/v1',
      kind: 'HelmChart',
      metadata: { namespace: 'kube-system' },
      spec: {
        chart: 'keda',
        version: '2.21.1',
        targetNamespace: 'keda',
        createNamespace: true,
      },
    });
  });

  it('scales the app’s deployment on its consumer’s backlog, down to none', () => {
    const so = JSON.parse(
      buildQueueScaledObject({
        deployment: 'mailer',
        namespace: 'p-shop',
        account: 'AABC',
        stream: 'ORDERS',
        consumer: 'mailer',
        lagThreshold: 20,
        minReplicas: 0,
        maxReplicas: 5,
      }),
    );
    expect(so.spec.scaleTargetRef).toEqual({ name: 'mailer' });
    expect(so.spec.minReplicaCount).toBe(0);
    expect(so.spec.triggers[0]).toEqual({
      type: 'nats-jetstream',
      metadata: {
        natsServerMonitoringEndpoint:
          'flui-nats.flui-system.svc.cluster.local:8222',
        accountID: 'AABC',
        stream: 'ORDERS',
        consumer: 'mailer',
        lagThreshold: '20',
        activationLagThreshold: '0',
      },
    });
  });
});
