jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClustersController } from './clusters.controller';
import { CreateClusterDto } from './dto/create-cluster.dto';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

/**
 * What a `cluster:manage` holder without `data:access` can make a cluster
 * record say, or make a new cluster's machines accept.
 */
describe('ClustersController writes', () => {
  const operator = {
    userId: 'op',
    email: 'op@x',
    roles: {},
    isAdmin: false,
  };

  const build = (withheld: string[] = []) => {
    const clustersService = {
      updateClusterMetadata: jest.fn(async () => ({ id: 'c1' })),
      updateNodeMetadata: jest.fn(async () => ({ id: 'n1', metadata: {} })),
      createCluster: jest.fn(async () => ({
        id: 'op-1',
        resourceId: 'c1',
        createdAt: new Date(0),
      })),
    };
    const policy = {
      check: jest.fn(
        async (_p: unknown, permission: string) =>
          !withheld.includes(permission),
      ),
    };
    const args: unknown[] = new Array(ClustersController.length).fill({});
    args[0] = clustersService;
    args[args.length - 1] = policy;
    const controller = new (ClustersController as unknown as new (
      ...a: unknown[]
    ) => ClustersController)(...args);
    return { controller, clustersService, policy };
  };

  describe('PATCH :id/metadata', () => {
    it('passes the BYOS SSH target the dashboard and the CLI write', async () => {
      const { controller, clustersService } = build();
      await controller.updateClusterMetadata('c1', {
        metadata: {
          byos: {
            host: 'h',
            port: 2222,
            user: 'u',
            nodeNetwork: '10.0.0.0/24',
          },
        },
      });
      expect(clustersService.updateClusterMetadata).toHaveBeenCalledWith('c1', {
        byos: { host: 'h', port: 2222, user: 'u', nodeNetwork: '10.0.0.0/24' },
      });
    });

    it.each([
      'isControlCluster',
      'isObservabilityCluster',
      'purpose',
      'vnetConfig',
      'hostLayer',
      'sshCaEnrolled',
      'suspendedPublicSsh',
      'providerFirewallId',
      'observabilityStack',
      'grafana',
      'anythingElse',
    ])('refuses %s with 400', async (key) => {
      const { controller, clustersService } = build();
      await expect(
        controller.updateClusterMetadata('c1', { metadata: { [key]: true } }),
      ).rejects.toThrow(BadRequestException);
      expect(clustersService.updateClusterMetadata).not.toHaveBeenCalled();
    });

    it('refuses an unknown key inside byos', async () => {
      const { controller } = build();
      await expect(
        controller.updateClusterMetadata('c1', {
          metadata: { byos: { port: 22, keyPath: '/root/.ssh/id' } },
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('PATCH :clusterId/nodes/:nodeId/metadata', () => {
    it.each(['vnetAttachment', 'byos', 'registered'])(
      'refuses %s with 400',
      async (key) => {
        const { controller, clustersService } = build();
        await expect(
          controller.updateNodeMetadata('c1', 'n1', {
            metadata: { [key]: true },
          }),
        ).rejects.toThrow(BadRequestException);
        expect(clustersService.updateNodeMetadata).not.toHaveBeenCalled();
      },
    );
  });

  describe('POST /infrastructure/clusters', () => {
    const body = (over: Record<string, unknown> = {}): CreateClusterDto =>
      Object.assign(new CreateClusterDto(), {
        name: 'wc-1',
        provider: CloudProvider.HETZNER,
        region: 'fsn1',
        nodeSize: 'cx22',
        workerCount: 0,
        ...over,
      });

    it('creates a cluster from what the dashboard sends', async () => {
      const { controller, clustersService } = build([
        IAM_PERMISSION.DATA_ACCESS,
      ]);
      await controller.createCluster(body({ sshKeys: [] }), {
        user: operator,
      } as never);
      expect(clustersService.createCluster).toHaveBeenCalled();
    });

    it.each([{ sshKeys: ['mine'] }, { image: 'my-snapshot' }])(
      'refuses %p to a principal without data:access',
      async (over) => {
        const { controller, clustersService } = build([
          IAM_PERMISSION.DATA_ACCESS,
        ]);
        await expect(
          controller.createCluster(body(over), { user: operator } as never),
        ).rejects.toThrow(ForbiddenException);
        expect(clustersService.createCluster).not.toHaveBeenCalled();
      },
    );

    it('accepts SSH keys from a principal holding data:access', async () => {
      const { controller, clustersService } = build();
      await controller.createCluster(body({ sshKeys: ['mine'] }), {
        user: operator,
      } as never);
      expect(clustersService.createCluster).toHaveBeenCalled();
    });

    it('refuses a protected metadata key with 400', async () => {
      const { controller, clustersService } = build();
      await expect(
        controller.createCluster(
          body({ metadata: { isControlCluster: true } }),
          { user: operator } as never,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(clustersService.createCluster).not.toHaveBeenCalled();
    });
  });
});
