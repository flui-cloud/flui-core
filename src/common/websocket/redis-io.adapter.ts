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
    keepPublishFailuresLocal(pub, this.logger);
    this.clients = [pub, sub];
    try {
      await Promise.all([pub.connect(), sub.connect()]);
    } catch (err) {
      await this.dispose();
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

  /**
   * Runs after Nest has closed every socket.io server through `close(server)`,
   * which must stay the inherited one: shadowing it left the websocket
   * connections open, and the HTTP server waiting on them never let shutdown
   * reach the queues.
   */
  async dispose(): Promise<void> {
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

/**
 * The adapter publishes without awaiting, so a publish rejected by a closed or
 * reconnecting client became an unhandled rejection that ended the process,
 * whatever job it was running. A lost broadcast is only a missed live update.
 */
function keepPublishFailuresLocal(client: Redis, logger: Logger): void {
  const publish = client.publish.bind(client) as (
    channel: string | Buffer,
    message: string | Buffer,
  ) => Promise<number>;
  client.publish = ((channel: string | Buffer, message: string | Buffer) =>
    publish(channel, message).catch((err: Error) => {
      logger.warn(`Websocket event not shared: ${err.message}`);
      return 0;
    })) as Redis['publish'];
}
