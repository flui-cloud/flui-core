const instances: FakeRedis[] = [];
const connectAs: (() => Promise<void>)[] = [];

class FakeRedis {
  status = 'wait';
  quit = jest.fn(() => new Promise<string>(() => undefined));
  disconnect = jest.fn(() => {
    this.status = 'end';
  });

  constructor() {
    instances.push(this);
  }

  duplicate(): FakeRedis {
    return new FakeRedis();
  }

  connect = jest.fn(async () => {
    const behaviour = connectAs.shift();
    if (behaviour) return behaviour();
    this.status = 'ready';
  });
}

jest.mock('ioredis', () => ({ __esModule: true, default: FakeRedis }));
jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: jest.fn(() => 'adapter'),
}));
jest.mock('@nestjs/platform-socket.io', () => ({
  IoAdapter: class {
    constructor(_app: unknown) {}
  },
}));

import { RedisIoAdapter } from './redis-io.adapter';

describe('RedisIoAdapter', () => {
  beforeEach(() => {
    instances.length = 0;
    connectAs.length = 0;
    jest.useRealTimers();
  });

  it('lets go of both clients at once when Redis refuses the connection', async () => {
    connectAs.push(
      () => Promise.reject(new Error('ECONNREFUSED')),
      () => new Promise<void>(() => undefined),
    );
    const adapter = new RedisIoAdapter({} as any);

    await expect(adapter.connect({ host: 'nowhere' })).rejects.toThrow(
      'ECONNREFUSED',
    );
    for (const client of instances) {
      expect(client.quit).not.toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
    }
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it('does not wait on a quit Redis never answers', async () => {
    jest.useFakeTimers();
    const adapter = new RedisIoAdapter({} as any);
    await adapter.connect({ host: 'redis' });

    let closed = false;
    const closing = adapter.close().then(() => (closed = true));
    await jest.advanceTimersByTimeAsync(2_000);
    await closing;

    expect(closed).toBe(true);
    for (const client of instances) {
      expect(client.quit).toHaveBeenCalled();
      expect(client.disconnect).toHaveBeenCalled();
    }
  });
});
