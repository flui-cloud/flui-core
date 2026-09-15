// The reconciler reaches the Kubernetes client through KubernetesService; the
// real package is ESM and Jest cannot parse it. Same stand-in the project's
// other Kubernetes specs use.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import {
  rewriteRemoteWriteArgs,
  TelemetryEndpointReconciler,
} from './telemetry-endpoint.reconciler';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { ClusterStatus, ClusterType } from '../entities/cluster.entity';

const SHARED_VNET = { vnetConfig: { vnetId: 'v1' } };

const control = (over: any = {}) => ({
  id: 'ctl',
  name: 'control-cluster',
  provider: 'hetzner',
  clusterType: ClusterType.CONTROL,
  status: ClusterStatus.READY,
  masterIpAddress: '1.2.3.4',
  masterPrivateIp: '10.0.0.1',
  metadata: SHARED_VNET,
  nodes: [],
  ...over,
});

const workload = (over: any = {}) => ({
  id: 'w',
  name: 'workload-1',
  provider: 'hetzner',
  clusterType: ClusterType.WORKLOAD,
  status: ClusterStatus.READY,
  masterIpAddress: '5.6.7.8',
  masterPrivateIp: '10.0.0.9',
  metadata: SHARED_VNET,
  nodes: [{ ipAddress: '5.6.7.8', privateIp: '10.0.0.9' }],
  ...over,
});

describe('TelemetryEndpointReconciler', () => {
  const build = (
    cluster: any,
    controlCluster: any,
    apply = jest.fn(),
    overlayFor?: jest.Mock,
    kube?: any,
  ) => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(cluster),
      find: jest.fn().mockResolvedValue(controlCluster ? [controlCluster] : []),
    };
    const svc = new TelemetryEndpointReconciler(
      repo as any,
      new ManagementAddressResolver(),
      { apply } as any,
      {
        overlayFor: overlayFor ?? jest.fn().mockResolvedValue(undefined),
      } as any,
      (kube ?? {
        getResource: jest.fn(),
        replaceManifest: jest.fn(),
      }) as any,
      { decrypt: (v: string) => v } as any,
    );
    return { svc, apply };
  };

  afterEach(() => {
    delete process.env.FLUI_LOKI_NODEPORT;
  });

  it('sends a same-network workload to the control private IP', async () => {
    const { svc } = build(workload(), control());
    await expect(svc.desiredEndpoint(workload() as any)).resolves.toBe(
      '10.0.0.1:30100',
    );
  });

  it('sends a workload with no shared network to the control public IP', async () => {
    const w = workload({ provider: 'ovh' });
    const { svc } = build(w, control());
    await expect(svc.desiredEndpoint(w as any)).resolves.toBe('1.2.3.4:30100');
  });

  it('keeps a control cluster ingesting its own telemetry locally', async () => {
    const c = control();
    const { svc } = build(c, c);
    await expect(svc.desiredEndpoint(c as any)).resolves.toBe('10.0.0.1:30100');
  });

  it('honours an overridden ingest NodePort, and ignores a nonsensical one', async () => {
    process.env.FLUI_LOKI_NODEPORT = '30111';
    const { svc } = build(workload(), control());
    await expect(svc.desiredEndpoint(workload() as any)).resolves.toBe(
      '10.0.0.1:30111',
    );
    process.env.FLUI_LOKI_NODEPORT = '22';
    await expect(svc.desiredEndpoint(workload() as any)).resolves.toBe(
      '10.0.0.1:30100',
    );
  });

  it('leaves nodes alone when no ingest address can be resolved', async () => {
    const { svc, apply } = build(workload(), null);
    await expect(svc.reconcile('w')).resolves.toMatchObject({ updated: 0 });
    expect(apply).not.toHaveBeenCalled();
  });

  describe('the script it runs', () => {
    const scriptFor = async (cluster: any, ctl: any) => {
      const apply = jest.fn().mockResolvedValue('FLUI_TELEMETRY_OK');
      const { svc } = build(cluster, ctl, apply);
      await svc.reconcile(cluster.id);
      return apply.mock.calls[0][1] as string;
    };

    it('rewrites both Loki sinks to the resolved endpoint', async () => {
      const script = await scriptFor(workload(), control());
      expect(script).toContain(
        `sed -i 's|^endpoint = "http://.*"|endpoint = "http://10.0.0.1:30100"|'`,
      );
    });

    it('does nothing when every sink already points there', async () => {
      const script = await scriptFor(workload(), control());
      expect(script).toContain('if [ "$TOTAL" = "$MATCH" ]; then echo');
    });

    it('restores the previous config if Vector refuses to restart', async () => {
      // Unattended safety: a bad endpoint that stops Vector would otherwise
      // cost the node's logs and the means of finding out why.
      const script = await scriptFor(workload(), control());
      expect(script).toContain('if ! systemctl restart vector; then');
      expect(script).toContain('mv "$CFG.flui-bak" "$CFG"');
      expect(script).toContain('FLUI_TELEMETRY_ROLLBACK');
    });

    it('treats a node without Vector as a non-event, not a failure', async () => {
      const script = await scriptFor(workload(), control());
      expect(script).toContain(
        'if [ ! -f "$CFG" ]; then echo FLUI_TELEMETRY_ABSENT',
      );
    });
  });

  it('counts what actually happened on each node', async () => {
    const apply = jest
      .fn()
      .mockResolvedValueOnce('FLUI_TELEMETRY_UPDATED\nFLUI_TELEMETRY_OK')
      .mockResolvedValueOnce('FLUI_TELEMETRY_OK')
      .mockResolvedValueOnce('FLUI_TELEMETRY_ABSENT\nFLUI_TELEMETRY_OK');
    const w = workload({
      nodes: [
        { ipAddress: '5.6.7.8', privateIp: '10.0.0.9' },
        { ipAddress: '5.6.7.9', privateIp: '10.0.0.10' },
        { ipAddress: '5.6.7.10', privateIp: '10.0.0.11' },
      ],
    });
    const { svc } = build(w, control(), apply);

    await expect(svc.reconcile('w')).resolves.toEqual({
      endpoint: '10.0.0.1:30100',
      updated: 1,
      unchanged: 1,
      absent: 1,
    });
  });

  describe('the management overlay', () => {
    const overlay = (enrolled: boolean) =>
      jest.fn().mockResolvedValue({ controlAddress: '10.250.0.1', enrolled });

    it('sends telemetry down the tunnel once a peer has handshaken', async () => {
      const w = workload({ provider: 'ovh' });
      const { svc } = build(w, control(), jest.fn(), overlay(true));
      await expect(svc.desiredEndpoint(w as any)).resolves.toBe(
        '10.250.0.1:30100',
      );
    });

    it('keeps the public path while the tunnel is unproven', async () => {
      // A peer row is not a working tunnel. Moving a flow onto one that has
      // never carried a packet trades a known path for a hopeful one.
      const w = workload({ provider: 'ovh' });
      const { svc } = build(w, control(), jest.fn(), overlay(false));
      await expect(svc.desiredEndpoint(w as any)).resolves.toBe(
        '1.2.3.4:30100',
      );
    });

    it('leaves a shared private network alone even with the tunnel up', async () => {
      const w = workload();
      const { svc } = build(w, control(), jest.fn(), overlay(true));
      await expect(svc.desiredEndpoint(w as any)).resolves.toBe(
        '10.0.0.1:30100',
      );
    });
  });

  describe('rewriteRemoteWriteArgs', () => {
    const flag = '-remoteWrite.url=';

    it('moves the target while keeping the path vmagent needs', () => {
      // Dropping /api/v1/write would leave a URL that answers 404 forever.
      const { args, changed } = rewriteRemoteWriteArgs(
        [`${flag}http://1.2.3.4:30428/api/v1/write`, '-other=x'],
        '10.250.0.1:30428',
      );
      expect(changed).toBe(true);
      expect(args[0]).toBe(`${flag}http://10.250.0.1:30428/api/v1/write`);
      expect(args[1]).toBe('-other=x');
    });

    it('matches on the flag, not on the old address', () => {
      // The old address is exactly what is unknown when someone else set it.
      const { changed } = rewriteRemoteWriteArgs(
        [`${flag}http://who-knows.example:9999/api/v1/write`],
        '10.250.0.1:30428',
      );
      expect(changed).toBe(true);
    });

    it('reports no change when it is already right', () => {
      const { changed } = rewriteRemoteWriteArgs(
        [`${flag}http://10.250.0.1:30428/api/v1/write`],
        '10.250.0.1:30428',
      );
      expect(changed).toBe(false);
    });

    it('survives a malformed URL by assuming the standard path', () => {
      const { args } = rewriteRemoteWriteArgs(
        [`${flag}not-a-url`],
        '10.250.0.1:30428',
      );
      expect(args[0]).toBe(`${flag}http://10.250.0.1:30428/api/v1/write`);
    });

    it('leaves args that are not the flag alone', () => {
      const { args, changed } = rewriteRemoteWriteArgs(
        ['-promscrape.config=/etc/vmagent/vmagent.yaml'],
        '10.250.0.1:30428',
      );
      expect(changed).toBe(false);
      expect(args).toEqual(['-promscrape.config=/etc/vmagent/vmagent.yaml']);
    });
  });

  describe('reconcileMetrics', () => {
    const deployment = (url: string) => ({
      kind: 'Deployment',
      metadata: { name: 'vmagent', namespace: 'flui-monitoring' },
      spec: {
        template: {
          spec: {
            containers: [
              { name: 'vmagent', args: [`-remoteWrite.url=${url}`] },
            ],
          },
        },
      },
    });

    const overlay = jest
      .fn()
      .mockResolvedValue({ controlAddress: '10.250.0.1', enrolled: true });

    it('patches the deployment onto the tunnel address', async () => {
      const replaceManifest = jest.fn();
      const w = {
        ...workload({ provider: 'ovh' }),
        kubeconfigEncrypted: 'kc',
      };
      const { svc } = build(w, control(), jest.fn(), overlay, {
        getResource: jest
          .fn()
          .mockResolvedValue(deployment('http://1.2.3.4:30428/api/v1/write')),
        replaceManifest,
      });

      await expect(svc.reconcileMetrics('w')).resolves.toMatchObject({
        endpoint: '10.250.0.1:30428',
        changed: true,
      });
      expect(replaceManifest).toHaveBeenCalled();
      expect(replaceManifest.mock.calls[0][1]).toContain('10.250.0.1:30428');
    });

    it('does nothing when the deployment already points there', async () => {
      const replaceManifest = jest.fn();
      const w = {
        ...workload({ provider: 'ovh' }),
        kubeconfigEncrypted: 'kc',
      };
      const { svc } = build(w, control(), jest.fn(), overlay, {
        getResource: jest
          .fn()
          .mockResolvedValue(
            deployment('http://10.250.0.1:30428/api/v1/write'),
          ),
        replaceManifest,
      });

      await expect(svc.reconcileMetrics('w')).resolves.toMatchObject({
        changed: false,
        reason: 'already correct',
      });
      expect(replaceManifest).not.toHaveBeenCalled();
    });

    it('says so plainly when the cluster has no metrics agent', async () => {
      const w = {
        ...workload({ provider: 'ovh' }),
        kubeconfigEncrypted: 'kc',
      };
      const { svc } = build(w, control(), jest.fn(), overlay, {
        getResource: jest.fn().mockResolvedValue({ spec: {} }),
        replaceManifest: jest.fn(),
      });

      await expect(svc.reconcileMetrics('w')).resolves.toMatchObject({
        reason: 'vmagent not deployed here',
      });
    });

    it('refuses without a kubeconfig rather than guessing', async () => {
      const { svc } = build(
        workload({ provider: 'ovh' }),
        control(),
        jest.fn(),
        overlay,
      );
      await expect(svc.reconcileMetrics('w')).resolves.toMatchObject({
        reason: 'no kubeconfig stored',
      });
    });
  });
});
