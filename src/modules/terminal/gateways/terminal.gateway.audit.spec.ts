jest.mock('../services/terminal.service', () => ({
  TerminalService: class {},
}));

import { TerminalGateway } from './terminal.gateway';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';

describe('TerminalGateway.handleConnect — audit', () => {
  const socket = (user: Record<string, unknown>) => ({
    id: 'sock-1',
    data: { user },
    emit: jest.fn(),
  });

  const person = { userId: 'u1', email: 'u@x', isAdmin: false };

  const gatewayWith = (
    resolve: () => Promise<unknown>,
    createConnection = jest.fn().mockResolvedValue(undefined),
  ) => {
    const record = jest.fn().mockResolvedValue(undefined);
    const gateway = new TerminalGateway(
      { createConnection } as never,
      {} as never,
      { enabled: true, noteDisabled: () => {} } as never,
      { resolve } as never,
      { record } as never,
    );
    return { gateway, record };
  };

  const target = {
    serverIp: '10.0.0.7',
    clusterId: 'c1',
    describedAs: 'node worker-1 of cluster c1',
  };

  it('records a refused open as a refused read of data', async () => {
    const { gateway, record } = gatewayWith(async () => null);

    await gateway.handleConnect(
      socket(person) as never,
      { serverId: 'srv-9', serverIp: '203.0.113.9' } as never,
    );

    expect(record).toHaveBeenCalledWith({
      userId: 'u1',
      email: 'u@x',
      actorKind: 'user',
      actorKeyId: null,
      action: 'terminal opened',
      target: { serverId: 'srv-9' },
      outcome: 'refused',
      dataAccess: true,
    });
  });

  it('records an opened shell', async () => {
    const { gateway, record } = gatewayWith(async () => target);

    await gateway.handleConnect(
      socket(person) as never,
      { serverId: 'srv-1', serverIp: 'ignored' } as never,
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'terminal opened',
        target: { serverId: 'srv-1' },
        outcome: 'ok',
        dataAccess: true,
      }),
    );
  });

  it('records a shell that was allowed but could not be opened as failed', async () => {
    const { gateway, record } = gatewayWith(
      async () => target,
      jest.fn().mockRejectedValue(new Error('ssh down')),
    );

    await gateway.handleConnect(
      socket(person) as never,
      { serverId: 'srv-1', serverIp: 'ignored' } as never,
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', dataAccess: true }),
    );
  });

  it('names an agent credential as an agent', async () => {
    const { gateway, record } = gatewayWith(async () => null);

    await gateway.handleConnect(
      socket({ ...person, scopes: [MCP_SCOPE.INFRA_WRITE] }) as never,
      { serverId: 'srv-1', serverIp: 'x' } as never,
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actorKind: 'agent' }),
    );
  });

  it('still opens the shell when no audit service is wired', async () => {
    const createConnection = jest.fn().mockResolvedValue(undefined);
    const gateway = new TerminalGateway(
      { createConnection } as never,
      {} as never,
      { enabled: true, noteDisabled: () => {} } as never,
      { resolve: async () => target } as never,
    );

    await gateway.handleConnect(
      socket(person) as never,
      { serverId: 'srv-1', serverIp: 'x' } as never,
    );

    expect(createConnection).toHaveBeenCalled();
  });
});
