jest.mock('@kubernetes/client-node', () => ({}));

import { EgressPolicyService } from './egress-policy.service';
import { EGRESS_POLICY_NAME } from './egress-policy.core';

describe('EgressPolicyService', () => {
  const build = (
    policy: { ports: Array<{ port: number; protocol: 'TCP' | 'UDP' }> } | null,
  ) => {
    const state = { policy };
    const applied: string[] = [];
    const deleted: string[] = [];
    const nsLabels: Record<string, Record<string, string>> = {
      'p-team': { 'flui.cloud/tier': 'user' },
      'p-guest': { 'flui.cloud/sandbox': 'true' },
      'flui-system': { 'flui.cloud/scope': 'system' },
    };
    const clusters = {
      findOne: jest.fn(async () => ({
        id: 'c1',
        kubeconfigEncrypted: 'enc',
        egressPolicy: state.policy,
      })),
      update: jest.fn(
        async (_id: string, patch: { egressPolicy: typeof policy }) => {
          state.policy = patch.egressPolicy;
        },
      ),
    };
    const service = new EgressPolicyService(
      clusters as never,
      {
        findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'app-1' ? { id: 'app-1', clusterId: 'c1' } : null,
        ),
        find: jest.fn(async () => [
          { id: 'a1', k8sNamespace: 'p-team' },
          { id: 'a2', k8sNamespace: 'flui-system' },
        ]),
      } as never,
      {
        applyManifest: jest.fn(async (_kc: string, yaml: string) => {
          applied.push(yaml);
        }),
        deleteResource: jest.fn(
          async (_kc: string, kind: string, name: string, ns: string) => {
            deleted.push(`${kind}/${name}@${ns}`);
          },
        ),
        listNamespaces: jest.fn(async () => [
          { metadata: { name: 'p-guest' } },
        ]),
        getResource: jest.fn(
          async (_kc: string, _kind: string, name: string) => ({
            metadata: { name, labels: nsLabels[name] },
          }),
        ),
      } as never,
      { decrypt: () => 'kc' } as never,
    );
    return { service, applied, deleted, state };
  };

  it('writes the new rule into every application namespace and guest area, never the platform', async () => {
    const { service, applied, state } = build(null);
    const result = await service.setPolicy('c1', [
      { port: 443, protocol: 'TCP' },
      { port: 80, protocol: 'TCP' },
    ]);

    expect(state.policy).toEqual({
      ports: [
        { port: 80, protocol: 'TCP' },
        { port: 443, protocol: 'TCP' },
      ],
    });
    expect(result.applied).toEqual(['p-guest', 'p-team']);
    expect(result.failed).toEqual([]);
    expect(applied).toHaveLength(2);
    expect(applied.join('\n')).not.toContain('flui-system');
  });

  it('removes the fence from application namespaces when the rule opens again', async () => {
    const { service, applied, deleted } = build({
      ports: [{ port: 443, protocol: 'TCP' }],
    });
    await service.setPolicy('c1', null);

    expect(deleted).toEqual([`NetworkPolicy/${EGRESS_POLICY_NAME}@p-team`]);
    // A guest area keeps its way out to the internet, private ranges excepted.
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('namespace: p-guest');
  });

  it('tells an application, and whoever reads about it, what it may reach and whom to ask', async () => {
    const { service } = build({
      ports: [
        { port: 443, protocol: 'TCP' },
        { port: 80, protocol: 'TCP' },
      ],
    });
    await expect(service.viewForApplication('app-1')).resolves.toEqual({
      open: false,
      ports: [
        { port: 443, protocol: 'TCP' },
        { port: 80, protocol: 'TCP' },
      ],
      summary:
        'Outbound traffic leaving the cluster is allowed on ports 443, 80; for any other port ask your administrator.',
    });
    await expect(service.viewForApplication('missing')).rejects.toThrow(
      'not found',
    );
  });

  it('answers a change with how many spaces carry it and where it failed', async () => {
    const { service } = build(null);
    const change = await service.change('c1', [{ port: 443, protocol: 'TCP' }]);
    expect(change).toMatchObject({ open: false, applied: 2, failed: [] });
  });
});
