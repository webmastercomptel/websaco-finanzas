// src/modules/reservas/reservas-vencimiento.service.ts
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
import { relojDeParedBogota } from '../../common/utils/reloj-bogota';
import {
  Reserva,
  type ReservaDocument,
} from '../../database/schemas/administracion/reserva.schema';

/**
 * Hourly sweep that cancels the reservation requests nobody answered before
 * they started. Nobody is notified, as in the system this was ported from: the
 * requester simply sees the booking as cancelled.
 */
@Injectable()
export class ReservasVencimientoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReservasVencimientoService.name);

  constructor(
    @InjectModel(Reserva.name)
    private readonly reservas: Model<ReservaDocument>,
    private readonly lock: LockService,
  ) {}

  /**
   * Runs every hour on every replica; the lock makes exactly one execute it, and
   * `ejecutarTareaProgramada` keeps a failure from becoming an unhandled
   * rejection in the scheduler. The update is idempotent, so a failed pass is
   * simply repeated at the next tick.
   *
   * It spans ALL coproperties on purpose: it is housekeeping with no request and
   * no tenant, and the tenancy law governs request-scoped reads.
   *
   * `activa` is cleared in the same update as `estado`: the cancelled booking
   * must free its slots for the double-booking guard.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async vencerPendientes(): Promise<void> {
    await ejecutarTareaProgramada(
      this.lock,
      this.logger,
      { clave: 'cron:reservas:vencer-pendientes', ttlMs: 600_000 },
      async () => {
        this.logger.debug('Cancelando reservas pendientes ya iniciadas');

        const resultado = await this.reservas
          .updateMany(
            // `inicio` is the Bogotá wall clock as UTC: compare on that scale,
            // or a request is cancelled 5 hours before its typed start.
            { estado: 'pendiente', inicio: { $lt: relojDeParedBogota() } },
            { $set: { estado: 'cancelada', activa: false } },
          )
          .exec();

        if (resultado.modifiedCount > 0) {
          this.logger.log(
            `Reservas pendientes vencidas canceladas: ${resultado.modifiedCount}`,
          );
        }
      },
    );
  }

  /**
   * Cloud Run scales to zero, so the hourly cron only fires if an instance
   * happens to be awake: catch up once the process is up.
   */
  onApplicationBootstrap(): void {
    ejecutarAlArrancar(this.logger, 'vencimiento de reservas pendientes', () =>
      this.vencerPendientes(),
    );
  }
}
