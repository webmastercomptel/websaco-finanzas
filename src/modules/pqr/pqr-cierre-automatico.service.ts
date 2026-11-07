import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ejecutarAlArrancar,
  ejecutarTareaProgramada,
} from '../../common/programacion/tarea-programada';
import { LockService } from '../../common/redis/lock.service';
import {
  Pqr,
  type PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';

/** Days a PQR may stay `resuelto` without any activity before it is closed. */
export const DIAS_PARA_CERRAR = 5;

/**
 * Nightly sweep that moves resolved PQRs to `cerrado` once they have sat
 * untouched for `DIAS_PARA_CERRAR` days. "Untouched" is `updatedAt`: any reply,
 * attachment or edit restarts the clock, so a resident who answers a resolution
 * keeps the case open. Nobody is notified, as in the system this was ported
 * from.
 */
@Injectable()
export class PqrCierreAutomaticoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PqrCierreAutomaticoService.name);

  constructor(
    @InjectModel(Pqr.name)
    private readonly pqrs: Model<PqrDocument>,
    private readonly lock: LockService,
  ) {}

  /**
   * Runs daily at midnight on every replica; the lock makes exactly one execute
   * it, and `ejecutarTareaProgramada` keeps a failure from becoming an unhandled
   * rejection in the scheduler. The update is idempotent, so a failed pass is
   * simply repeated at the next tick.
   *
   * It spans ALL coproperties on purpose: it is housekeeping with no request and
   * no tenant, and the tenancy law governs request-scoped reads.
   *
   * Timezone caveat, kept from the original: "midnight" and the 5-day cut-off
   * are the SERVER's local time, and Cloud Run runs in UTC. So the sweep fires at
   * 19:00 in Bogotá, and a PQR is closed when it has been quiet for 5 x 24 hours
   * counted from that instant. Fixing it means choosing a product timezone for
   * the schedule, not changing this line in a port.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cerrarResueltas(): Promise<void> {
    await ejecutarTareaProgramada(
      this.lock,
      this.logger,
      { clave: 'cron:pqr:cierre-automatico', ttlMs: 600_000 },
      async () => {
        const limite = new Date();
        limite.setDate(limite.getDate() - DIAS_PARA_CERRAR);

        const resultado = await this.pqrs
          .updateMany(
            { estado: 'resuelto', updatedAt: { $lt: limite } },
            { $set: { estado: 'cerrado' } },
          )
          .exec();

        this.logger.log(
          `PQR resueltas cerradas automáticamente: ${resultado.modifiedCount}`,
        );
      },
    );
  }

  /**
   * Cloud Run scales to zero, so the midnight cron only fires if an instance
   * happens to be awake: catch up once the process is up.
   */
  onApplicationBootstrap(): void {
    ejecutarAlArrancar(this.logger, 'cierre automático de PQR', () =>
      this.cerrarResueltas(),
    );
  }
}
