import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import Redis, { RedisOptions } from 'ioredis';
import { ServerOptions } from 'socket.io';

const CLOSE_TIMEOUT_MS = 2_000;

/**
 * Socket.io across every copy of the API. An event a copy emits to a room, a
 * bell for one person or a build's log for one application, reaches the
 * browsers connected to the other copies too, through Redis.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapter?: ReturnType<
    typeof import('@socket.io/redis-adapter').createAdapter
  >;
  private clients: Redis[] = [];

  constructor(app: INestApplicationContext) {
    super(app);
  }

  async connect(options: RedisOptions): Promise<void> {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const pub = new Redis({ ...options, lazyConnect: true });
    const sub = pub.duplicate();
    this.clients = [pub, sub];
    try {
      await Promise.all([pub.connect(), sub.connect()]);
    } catch (err) {
      await this.close();
      throw err;
    }
    this.adapter = createAdapter(pub, sub, { key: 'flui:socket.io' });
    this.logger.log('Websocket events are shared between copies of the API');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => this.closeClient(c)));
  }

  /** A client that never connected would hold `quit()` forever in its offline queue. */
  private async closeClient(client: Redis): Promise<void> {
    if (client.status === 'ready') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        client.quit().catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    client.disconnect();
  }
}
