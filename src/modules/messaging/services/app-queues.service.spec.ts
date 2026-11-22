jest.mock('@kubernetes/client-node', () => ({}));
const connectMock = jest.fn();
jest.mock('nats', () => ({
  ...jest.requireActual('nats'),
  connect: (...a: unknown[]) => connectMock(...a),
}));

import { AppQueuesService } from './app-queues.service';
import { NatsConnectionService } from './nats-connection.service';
import { newAccountKey, seedOf } from '../nats/nats-jwt';

const USER = { userId: 'u1', email: 'u@example.com' } as never;

function build(options: { account?: boolean; denied?: boolean } = {}) {
  const account = newAccountKey();
  const dispose = jest.fn(async () => undefined);
  const tunnels = {
    open: jest.fn(async () => ({ localPort: 41000, dispose })),
  };
  const jsm = {
    streams: {
      list: () => ({ next: async () => [] }),
      add: jest.fn(),
      delete: jest.fn(),
    },
    consumers: { add: jest.fn(), info: jest.fn() },
  };
  const close = jest.fn();
  connectMock
    .mockReset()
    .mockResolvedValue({ jetstreamManager: async () => jsm, close });
  const service = new AppQueuesService(
    {
      findOne: async () =>
        options.account === false
          ? null
          : {
              publicKey: account.getPublicKey(),
              seed: `enc:${seedOf(account)}`,
            },
    } as never,
    {
      findById: async () => ({ id: 'a1', slug: 'shop', clusterId: 'c1' }),
    } as never,
    {
      assertCan: jest.fn(async () => {
        if (options.denied) throw new Error('forbidden');
      }),
    } as never,
    new NatsConnectionService(
      { findOne: async () => ({ kubeconfigEncrypted: 'kc' }) } as never,
      { decrypt: (v: string) => v.replace(/^enc:/, '') } as never,
      tunnels as never,
    ),
  );
  return { service, tunnels, account, dispose, close };
}

describe('the queues of an application', () => {
  it('reaches its account through a tunnel to the cluster’s NATS, as a user that expires', async () => {
    const { service, tunnels, account, dispose, close } = build();
    await expect(service.list(USER, 'a1')).resolves.toEqual([]);
    expect(tunnels.open).toHaveBeenCalledWith(
      'kc',
      'flui-system',
      'app=flui-nats',
      4222,
    );
    const [{ servers }] = connectMock.mock.calls[0] as [{ servers: string }];
    expect(servers).toBe('127.0.0.1:41000');
    expect(close).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    void account;
  });

  it('refuses an application without a NATS account', async () => {
    const { service } = build({ account: false });
    await expect(service.list(USER, 'a1')).rejects.toThrow('no NATS account');
  });

  it('asks the caller’s permission before opening anything', async () => {
    const { service, tunnels } = build({ denied: true });
    await expect(service.list(USER, 'a1')).rejects.toThrow('forbidden');
    expect(tunnels.open).not.toHaveBeenCalled();
  });
});
