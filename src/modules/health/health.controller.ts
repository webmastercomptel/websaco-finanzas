// src/modules/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private mongoose: MongooseHealthIndicator,
    private redis: RedisHealthIndicator,
  ) {}

  /**
   * Liveness: the process is up and can serve. No dependency checks — a slow
   * Mongo/Redis must NOT trigger a pod restart, only a readiness removal.
   */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: safe to receive traffic — Mongo AND Redis reachable. Point the
   * load balancer / orchestrator readiness probe here.
   *
   * Both services are managed and remote, so this endpoint doubles as the
   * fastest answer to "are my connection strings right?" — which is exactly
   * what `/conectar-servicios` is meant to check.
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb'),
      () => this.redis.pingCheck('redis'),
    ]);
  }

  /** Default endpoint — full readiness check (Mongo + Redis). */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb'),
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
