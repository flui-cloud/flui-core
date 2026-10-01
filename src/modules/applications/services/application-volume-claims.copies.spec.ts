jest.mock('@kubernetes/client-node', () => ({}));

import { ApplicationVolumeClaimsService } from './application-volume-claims.service';

describe('which volumes of an application a copy takes', () => {
  const app = { id: 'a1', slug: 'linkding', k8sNamespace: 'user-x' };
  const claim = (name: string, labels: Record<string, string> = {}) => ({
    metadata: { name, labels: { 'flui-app-id': 'a1', ...labels } },
    spec: {},
    status: { phase: 'Bound' },
  });
  const service = (claims: any[], mountedClaim: string) =>
    new ApplicationVolumeClaimsService({
      listResourcesByLabel: jest.fn(async (_kc: string, kind: string) => {
        if (kind === 'PersistentVolumeClaim') return claims;
        if (kind === 'Deployment') {
          return [
            {
              spec: {
                template: {
                  spec: {
                    volumes: [
                      {
                        name: 'data',
                        persistentVolumeClaim: { claimName: mountedClaim },
                      },
                    ],
                  },
                },
              },
            },
          ];
        }
        return [];
      }),
    } as never);

  const after = [
    claim('data', { 'flui.cloud/previous-volume': 'true' }),
    claim('data-restored-1', { 'flui.cloud/restored-from': 'b1' }),
    claim('data-restored-2', { 'flui.cloud/restored-from': 'b2' }),
    claim('data-clone', { 'flui.cloud/pvc-clone-export': 'true' }),
  ];

  it('takes the restored copy the application was switched to, and nothing spare', async () => {
    const claims = await service(
      after,
      'data-restored-1',
    ).resolveForApplication('kc', app, [], { excludeCopies: true });
    expect(claims.map((c) => c.name)).toEqual(['data-restored-1']);
  });

  it('still lists every volume for teardown and the removal preview', async () => {
    const claims = await service(
      after,
      'data-restored-1',
    ).resolveForApplication('kc', app, []);
    expect(claims).toHaveLength(4);
  });
});
