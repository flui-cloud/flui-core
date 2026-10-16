import { BadRequestException, NotFoundException } from '@nestjs/common';
import { KubeconfigDemotionService } from './kubeconfig-demotion.service';
import { CrossProviderFirewallService } from '../../firewalls/services/cross-provider-firewall.service';
import { ClusterType } from '../../clusters/entities/cluster.entity';

const kubeconfig = (host: string) =>
  [
    'apiVersion: v1',
    'clusters:',
    '- cluster:',
    '    certificate-authority-data: LS0tLUNBLS0tLQ==',
    `    server: https://${host}:6443`,
    '  name: default',
  ].join('\n');

const workload = (host = '10.250.0.4', over: Record<string, unknown> = {}) => ({
  id: 'wl',
  name: 'demo-cluster',
  clusterType: ClusterType.WORKLOAD,
  kubeconfigEncrypted: `enc:${kubeconfig(host)}`,
  metadata: { vnetConfig: { vnetId: 'v' } },
  nodes: [{ id: 'm', nodeType: 'master', ipAddress: '51.15.1.2' }],
  ...over,
});

const build = (cluster: any) => {
  const save = jest.fn(async (c) => c);
  const reconcileAllPeers = jest.fn();
  const svc = new KubeconfigDemotionService(
    { findOne: jest.fn().mockResolvedValue(cluster), save } as any,
    {
      decrypt: (v: string) => v.replace(/^enc:/, ''),
      encrypt: (v: string) => `enc:${v}`,
    } as any,
    {
      get: (token: unknown) =>
        token === CrossProviderFirewallService ? { reconcileAllPeers } : null,
    } as any,
  );
  return { svc, save, reconcileAllPeers };
};

describe('moving a cluster back off the Flui network by hand', () => {
  it('rewrites the stored address to the public one, keeps the port, and holds it there', async () => {
    const cluster = workload();
    const { svc, save } = build(cluster);

    const result = await svc.demote('wl', 'ops@example.org');

    expect(result).toEqual({
      clusterId: 'wl',
      clusterName: 'demo-cluster',
      from: '10.250.0.4',
      to: '51.15.1.2',
      changed: true,
      held: true,
    });
    const saved = save.mock.calls[0][0];
    expect(saved.kubeconfigEncrypted).toContain(
      'server: https://51.15.1.2:6443',
    );
    expect(saved.metadata.overlayDemotion).toMatchObject({
      by: 'ops@example.org',
      from: '10.250.0.4',
      to: '51.15.1.2',
    });
    expect(saved.metadata.vnetConfig).toEqual({ vnetId: 'v' });
  });

  it('reopens the public API path on the same call, through the firewall pass', async () => {
    const { svc, reconcileAllPeers } = build(workload());
    await svc.demote('wl', 'ops');
    expect(reconcileAllPeers).toHaveBeenCalled();
  });

  it('still holds a cluster that was already on its public address', async () => {
    const { svc, save } = build(workload('51.15.1.2'));
    const result = await svc.demote('wl', 'ops');
    expect(result.changed).toBe(false);
    expect(save.mock.calls[0][0].metadata.overlayDemotion).toBeDefined();
  });

  it('succeeds even when the firewall pass fails: the rule returns on the next one', async () => {
    const cluster = workload();
    const { svc } = build(cluster);
    (svc as any).moduleRef = {
      get: () => ({
        reconcileAllPeers: jest.fn().mockRejectedValue(new Error('provider')),
      }),
    };
    await expect(svc.demote('wl', 'ops')).resolves.toMatchObject({
      changed: true,
    });
  });

  it('refuses the control cluster', async () => {
    const { svc } = build(
      workload('1.1.1.1', { clusterType: ClusterType.CONTROL }),
    );
    await expect(svc.demote('wl', 'ops')).rejects.toThrow(BadRequestException);
  });

  it('refuses a cluster with no public address to go back to', async () => {
    const { svc } = build(
      workload('10.250.0.4', { nodes: [{ id: 'm', nodeType: 'master' }] }),
    );
    await expect(svc.demote('wl', 'ops')).rejects.toThrow(/no public address/);
  });

  it('refuses a cluster that does not exist', async () => {
    const { svc } = build(null);
    await expect(svc.demote('wl', 'ops')).rejects.toThrow(NotFoundException);
  });

  it('releases the hold without touching the address', async () => {
    const cluster = workload('51.15.1.2', {
      metadata: {
        vnetConfig: { vnetId: 'v' },
        overlayDemotion: { at: 'x', by: 'ops', from: 'a', to: 'b' },
      },
    });
    const { svc, save } = build(cluster);

    const result = await svc.release('wl', 'ops');

    expect(result.held).toBe(false);
    const saved = save.mock.calls[0][0];
    expect(saved.metadata).toEqual({ vnetConfig: { vnetId: 'v' } });
    expect(saved.kubeconfigEncrypted).toContain('51.15.1.2');
  });
});
