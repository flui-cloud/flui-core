import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

const PREFIX = 'flui:numbers:';

/**
 * Small numbers every copy of the API must agree on, kept in Redis: a count
 * that grows on whichever copy served the request, a window of recent
 * samples. When Redis does not answer, reads come back empty and writes are
 * dropped with a warning: these describe the installation, they do not run it.
 */
@Injectable()
export class SharedNumbersService implements OnApplicationShutdown {
  private readonly logger = new Logger(SharedNumbersService.name);
  private client: Redis | null = null;

  private get redis(): Redis {
    this.client ??= new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    return this.client;
  }

  async increment(name: string): Promise<void> {
    await this.redis.incr(PREFIX + name).catch((e: Error) => this.warn(e));
  }

  async count(name: string): Promise<number> {
    const raw = await this.redis
      .get(PREFIX + name)
      .catch((e: Error) => this.warn(e));
    return Number(raw ?? 0) || 0;
  }

  /** Keeps the `keep` most recent samples. */
  async sample(name: string, value: number, keep: number): Promise<void> {
    await this.redis
      .multi()
      .lpush(PREFIX + name, String(value))
      .ltrim(PREFIX + name, 0, keep - 1)
      .exec()
      .catch((e: Error) => this.warn(e));
  }

  async samples(name: string): Promise<number[]> {
    const raw = await this.redis
      .lrange(PREFIX + name, 0, -1)
      .catch((e: Error) => this.warn(e));
    return (raw ?? []).map(Number).filter(Number.isFinite);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  private warn(error: Error): undefined {
    this.logger.warn(`Redis did not answer: ${error.message}`);
    return undefined;
  }
}
