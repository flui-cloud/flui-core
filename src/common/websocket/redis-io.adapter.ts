import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import Redis, { RedisOptions } from 'ioredis';
import { ServerOptions } from 'socket.io';

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
    await Promise.all([pub.connect(), sub.connect()]);
    this.clients = [pub, sub];
    this.adapter = createAdapter(pub, sub, { key: 'flui:socket.io' });
    this.logger.log('Websocket events are shared between copies of the API');
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapter) server.adapter(this.adapter);
    return server;
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
  }
}
