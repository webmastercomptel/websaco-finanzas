import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * A single shared ioredis connection, built from the one connection string the
 * provider hands you (`redis://…` or, over TLS, `rediss://…`). ioredis reads
 * host, port, credentials and TLS straight off that URL, so there is nothing
 * else to assemble and nothing to get subtly wrong.
 *
 * An `error` listener is attached so a transient blip never crashes the process
 * with an unhandled 'error' event — a managed instance will drop idle
 * connections, and that is normal, not fatal.
 */
export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const logger = new Logger('RedisClient');
    const url = config.get<string>('app.redisUrl')!;
    const client = new Redis(url, {
      // A managed instance can be briefly unreachable. Back off instead of
      // hammering it, and cap the delay so recovery stays quick.
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    client.on('error', (err: Error) => logger.error(`Redis: ${err.message}`));
    return client;
  },
};
