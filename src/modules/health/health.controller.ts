// src/modules/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';
import { IntegracionComptableHealthIndicator } from './integracion-comptable.health';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private mongoose: MongooseHealthIndicator,
    private redis: RedisHealthIndicator,
    private integracionComptable: IntegracionComptableHealthIndicator,
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
   * Readiness: safe to receive traffic — Mongo AND Redis reachable, and the
   * environment's manual configuration steps done (today: the Comptable
   * integration's URL and shared secret, when it is enabled). Point the load
   * balancer / orchestrator readiness probe here.
   *
   * Both services are managed and remote, so this endpoint doubles as the
   * fastest answer to "are my connection strings right?" — which is exactly
   * what `/conectar-servicios` is meant to check.
   *
   * The Comptable configuration check lives only here, not in `check()`: a
   * wrong URL is fixed by editing the setting and redeploying, never by
   * restarting the instance, and the Dockerfile's HEALTHCHECK probes
   * `check()`, where a restart loop over a config mistake would be exactly the
   * wrong reaction (rule 4: dependency and environment checks belong in
   * readiness). It reads configuration only and never calls Comptable.
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb'),
      () => this.redis.pingCheck('redis'),
      () => this.integracionComptable.check('integracion-comptable'),
    ]);
  }

  /**
   * Default endpoint — connectivity only (Mongo + Redis). Used by the
   * Dockerfile HEALTHCHECK, so it must not include per-environment
   * configuration checks; see `ready()`.
   */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.mongoose.pingCheck('mongodb'),
      () => this.redis.pingCheck('redis'),
    ]);
  }
}
