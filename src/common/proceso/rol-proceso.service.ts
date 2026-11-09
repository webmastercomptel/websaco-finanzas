import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullRegistrar } from '@nestjs/bullmq';
import {
  ejecutaTrabajadoresDeCola,
  establecerRolProceso,
  type RolProceso,
} from './rol-proceso';

/**
 * Applies `APP_ROLE`. `AppModule` configures BullMQ with `manualRegistration`,
 * so no worker opens by itself; this service opens them only when the role
 * runs queue consumers. Queues and `QueueEvents` (what an HTTP request uses to
 * enqueue a lote and await its result) are untouched, so an `api` process still
 * enqueues — it needs a `worker`/`all` process somewhere to consume.
 */
@Injectable()
export class RolProcesoService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(RolProcesoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registrar: BullRegistrar,
  ) {}

  /** Joi gives APP_ROLE a default, so `?? 'all'` only satisfies the type. */
  private rol(): RolProceso {
    return this.config.get<RolProceso>('app.appRole') ?? 'all';
  }

  /** Before any bootstrap hook, so start-up catch-up passes see the role. */
  onModuleInit(): void {
    establecerRolProceso(this.rol());
  }

  onApplicationBootstrap(): void {
    const rol = this.rol();
    if (!ejecutaTrabajadoresDeCola(rol)) {
      this.logger.log(`APP_ROLE=${rol}: no queue workers, no scheduled jobs.`);
      return;
    }
    this.registrar.register();
  }
}
