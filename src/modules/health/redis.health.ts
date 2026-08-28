import { Inject, Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis/redis.constants';

/**
 * Terminus health indicator that PINGs the shared Redis connection. Readiness
 * must fail when Redis is unreachable — otherwise a load balancer keeps routing
 * traffic to an instance that cannot reach a dependency it needs.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    super();
  }

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    try {
      const pong = await this.redis.ping();
      const isHealthy = pong === 'PONG';
      const result = this.getStatus(key, isHealthy);
      if (isHealthy) return result;
      throw new HealthCheckError('Redis ping did not return PONG', result);
    } catch (err) {
      throw new HealthCheckError(
        'Redis unreachable',
        this.getStatus(key, false, { message: (err as Error).message }),
      );
    }
  }
}
