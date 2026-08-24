// `TerminalService` reaches `@kubernetes/client-node`, which ships ESM this
// runner does not transform. Stubbed at the module boundary rather than with
// `import type` on the injected class: erasing the import erases
// `design:paramtypes` and Nest then cannot construct the gateway at all.
jest.mock('../services/terminal.service', () => ({
  TerminalService: class {},
}));

import {
  TERMINAL_NO_SUCH_SERVER_CODE,
  TerminalGateway,
} from './terminal.gateway';
import { TerminalTargetResolver } from '../services/terminal-target.resolver';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';

/**
 * Decision 65. The gateway used to take `serverId`, `serverIp` and `clusterId`
 * from the message and sign an SSH certificate for whatever they said. The
 * feature being off is not the property under test here — the point of the
 * repair is that turning it on stops being dangerous.
 */

const socket = () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    id: 'sock-1',
    data: { user: { userId: 'u1', email: 'u@x', isAdmin: false } },
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    emitted,
  };
};

const gatewayWith = (
  resolve: TerminalTargetResolver['resolve'],
  createConnection = jest.fn().mockResolvedValue(undefined),
) => {
  const terminalService = { createConnection } as never;
  const gateway = new TerminalGateway(
    terminalService,
    {} as never,
    { enabled: false, noteDisabled: () => {} } as never,
    { resolve } as never,
  );
  return { gateway, createConnection };
};

describe('TerminalGateway.handleConnect — whose server is it', () => {
  it('refuses a server the caller cannot manage, and says it like a miss', async () => {
    const { gateway, createConnection } = gatewayWith(async () => null);
    const s = socket();

    await gateway.handleConnect(
      s as never,
      {
        serverId: 'someone-elses',
        serverIp: '203.0.113.9',
      } as never,
    );

    expect(createConnection).not.toHaveBeenCalled();
    expect(s.emitted).toEqual([
      {
        event: 'terminal:error',
        payload: expect.objectContaining({
          code: TERMINAL_NO_SUCH_SERVER_CODE,
        }),
      },
    ]);
  });

  it('opens the shell on the address Flui holds, not the one the client sent', async () => {
    const { gateway, createConnection } = gatewayWith(async () => ({
      serverIp: '10.0.0.7',
      clusterId: 'cluster-a',
      describedAs: 'node worker-1 of cluster cluster-a',
    }));
    const s = socket();

    await gateway.handleConnect(
      s as never,
      {
        serverId: 'node-1',
        // What an attacker would put here once they hold one legitimate id.
        serverIp: '203.0.113.9',
        clusterId: 'cluster-of-somebody-else',
      } as never,
    );

    expect(createConnection).toHaveBeenCalledTimes(1);
    const options = createConnection.mock.calls[0][0];
    expect(options.serverIp).toBe('10.0.0.7');
    expect(options.clusterId).toBe('cluster-a');
  });
});

describe('TerminalTargetResolver — resolve, then ask', () => {
  const policy = (answer: boolean) => ({
    check: jest.fn().mockResolvedValue(answer),
  });
  const repo = (row: unknown) => ({
    findOne: jest.fn().mockResolvedValue(row),
  });

  const user = { userId: 'u1', email: 'u@x', isAdmin: false } as never;

  it('answers nothing at all without a principal or an id', async () => {
    const r = new TerminalTargetResolver(
      repo(null) as never,
      repo(null) as never,
      repo(null) as never,
      policy(true) as never,
    );
    await expect(r.resolve(undefined, 'x')).resolves.toBeNull();
    await expect(r.resolve(user, undefined)).resolves.toBeNull();
  });

  it('asks cluster:manage about the cluster the node belongs to', async () => {
    const engine = policy(true);
    const r = new TerminalTargetResolver(
      repo({
        id: 'n1',
        clusterId: 'c1',
        serverName: 'worker-1',
        ipAddress: '10.0.0.7',
      }) as never,
      repo({ id: 'c1', name: 'control', provider: 'hetzner' }) as never,
      repo(null) as never,
      engine as never,
    );

    await expect(r.resolve(user, 'prov-123')).resolves.toMatchObject({
      serverIp: '10.0.0.7',
      clusterId: 'c1',
    });
    expect(engine.check).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      IAM_PERMISSION.CLUSTER_MANAGE,
      expect.objectContaining({ clusterId: 'c1', clusterName: 'control' }),
    );
  });

  it('refuses as absence when the permission is not held', async () => {
    const r = new TerminalTargetResolver(
      repo({
        id: 'n1',
        clusterId: 'c1',
        serverName: 'worker-1',
        ipAddress: '10.0.0.7',
      }) as never,
      repo({ id: 'c1', name: 'control' }) as never,
      repo(null) as never,
      policy(false) as never,
    );
    await expect(r.resolve(user, 'prov-123')).resolves.toBeNull();
  });

  it('refuses a credential whose scopes do not carry cluster:manage, even for an admin', async () => {
    // The ceiling is enforced by two HTTP guards and a socket meets neither;
    // the policy engine cannot stand in, because it short-circuits on isAdmin.
    const engine = policy(true);
    const r = new TerminalTargetResolver(
      repo({
        id: 'n1',
        clusterId: 'c1',
        serverName: 'worker-1',
        ipAddress: '10.0.0.7',
      }) as never,
      repo({ id: 'c1', name: 'control' }) as never,
      repo(null) as never,
      engine as never,
    );

    const agentKey = {
      userId: 'u1',
      email: 'u@x',
      isAdmin: true,
      scopes: [MCP_SCOPE.APP_READ],
    } as never;

    await expect(r.resolve(agentKey, 'prov-123')).resolves.toBeNull();
    // Refused before the grant is even asked for: a ceiling only takes away.
    expect(engine.check).not.toHaveBeenCalled();
  });

  it('lets an uncapped credential through — a session declares no ceiling', async () => {
    const engine = policy(true);
    const r = new TerminalTargetResolver(
      repo({
        id: 'n1',
        clusterId: 'c1',
        serverName: 'worker-1',
        ipAddress: '10.0.0.7',
      }) as never,
      repo({ id: 'c1', name: 'control' }) as never,
      repo(null) as never,
      engine as never,
    );

    await expect(
      r.resolve({ userId: 'u1', email: 'u@x', isAdmin: false } as never, 'p-1'),
    ).resolves.toMatchObject({ serverIp: '10.0.0.7' });
    expect(engine.check).toHaveBeenCalled();
  });

  it('lets a scope that does carry cluster:manage reach the policy engine', async () => {
    const engine = policy(true);
    const r = new TerminalTargetResolver(
      repo({
        id: 'n1',
        clusterId: 'c1',
        serverName: 'worker-1',
        ipAddress: '10.0.0.7',
      }) as never,
      repo({ id: 'c1', name: 'control' }) as never,
      repo(null) as never,
      engine as never,
    );

    await expect(
      r.resolve(
        {
          userId: 'u1',
          email: 'u@x',
          isAdmin: false,
          scopes: [MCP_SCOPE.BACKUP_WRITE],
        } as never,
        'p-1',
      ),
    ).resolves.toMatchObject({ serverIp: '10.0.0.7' });
    expect(engine.check).toHaveBeenCalled();
  });

  it('never queries a uuid column with something that is not one', async () => {
    const nodes = { findOne: jest.fn().mockResolvedValue(null) };
    const servers = { findOne: jest.fn().mockResolvedValue(null) };
    const r = new TerminalTargetResolver(
      nodes as never,
      repo(null) as never,
      servers as never,
      policy(true) as never,
    );

    await expect(r.resolve(user, "'; drop table --")).resolves.toBeNull();
    // Only the providerResourceId lookup, never the id one.
    expect(nodes.findOne).toHaveBeenCalledTimes(1);
    expect(servers.findOne).toHaveBeenCalledTimes(1);
  });
});
