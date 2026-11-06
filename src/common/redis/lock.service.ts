import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

// Release only if we still own the lock (Redlock-style): prevents deleting a
// lock that already expired and was re-acquired by another instance.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Runs `task` only if this instance wins the named lock, so a job scheduled on
   * every replica (e.g. a @Cron) executes on exactly one instance. Returns true
   * if it ran here, false if another instance holds the lock or Redis is down.
   *
   * @param key   Lock name, e.g. 'cron:pqrs:auto-close'.
   * @param ttlMs Auto-expiry — must exceed the task's worst-case duration.
   */
  async runExclusive(
    key: string,
    ttlMs: number,
    task: () => Promise<void>,
  ): Promise<boolean> {
    const token = randomUUID();
    let acquired: string | null = null;
    try {
      acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    } catch (err) {
      this.logger.error(
        `No se pudo tomar el lock ${key}: ${(err as Error).message}`,
      );
      return false;
    }

    if (acquired !== 'OK') {
      this.logger.debug(`Lock ${key} tomado por otra instancia — se omite.`);
      return false;
    }

    try {
      await task();
      return true;
    } finally {
      await this.redis
        .eval(RELEASE_SCRIPT, 1, key, token)
        .catch(() => undefined);
    }
  }
}
