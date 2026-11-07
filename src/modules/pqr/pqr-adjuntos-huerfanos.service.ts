// src/modules/pqr/pqr-adjuntos-huerfanos.service.ts
import type { Bucket } from '@google-cloud/storage';
import {
  Inject,
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
import { GCS_BUCKET } from '../../common/storage/storage.constants';
import {
  Pqr,
  type PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import { esRutaDeAdjuntoPqr } from './pqr-adjuntos.service';

/**
 * Grace before an unconfirmed attachment counts as abandoned: one hour, well
 * above the 15-minute signed upload URL (a test pins the relation), so nobody
 * can still be mid-upload when its entry is removed.
 */
export const GRACIA_ADJUNTOS_PENDIENTES_MS = 60 * 60 * 1000;

/**
 * Nightly cleanup of abandoned PQR attachment uploads, the same pattern as
 * `DocumentosHuerfanosService`:
 * 1. It never lists the bucket: it only reads `pendiente` ENTRIES, so it cannot
 *    reach an object nobody registered.
 * 2. It only pulls entries that are still `pendiente` and older than the grace,
 *    re-checked atomically inside the `$pull`, so a confirmation mid-run wins.
 *    An entry without `creadoEn` (migrated) is never swept.
 * 3. The entry goes first and its object only if the pull really removed it.
 * 4. The object is deleted only inside `pqrs/`.
 *
 * Spans all coproperties on purpose (housekeeping, no request, no tenant).
 */
@Injectable()
export class PqrAdjuntosHuerfanosService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PqrAdjuntosHuerfanosService.name);

  constructor(
    @InjectModel(Pqr.name) private readonly pqrs: Model<PqrDocument>,
    @Inject(GCS_BUCKET) private readonly bucket: Bucket,
    private readonly lock: LockService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async limpiarPendientes(): Promise<void> {
    await ejecutarTareaProgramada(
      this.lock,
      this.logger,
      { clave: 'cron:pqr:adjuntos-huerfanos', ttlMs: 1_800_000 },
      async () => {
        const limite = new Date(Date.now() - GRACIA_ADJUNTOS_PENDIENTES_MS);
        const conAbandonados = await this.pqrs
          .find({
            archivosAdjuntos: {
              $elemMatch: { estado: 'pendiente', creadoEn: { $lt: limite } },
            },
          })
          .select('_id archivosAdjuntos')
          .lean()
          .exec();

        let entradas = 0;
        let objetos = 0;
        for (const pqr of conAbandonados) {
          for (const adjunto of pqr.archivosAdjuntos ?? []) {
            if (
              adjunto.estado !== 'pendiente' ||
              !adjunto.creadoEn ||
              adjunto.creadoEn >= limite
            ) {
              continue;
            }
            try {
              const quitado = await this.pqrs
                .updateOne(
                  { _id: pqr._id },
                  {
                    $pull: {
                      archivosAdjuntos: {
                        _id: adjunto._id,
                        estado: 'pendiente',
                        creadoEn: { $lt: limite },
                      },
                    },
                  },
                )
                .exec();
              if (quitado.modifiedCount !== 1) continue;
              entradas += 1;
              if (esRutaDeAdjuntoPqr(adjunto.rutaAlmacenamiento)) {
                await this.bucket.file(adjunto.rutaAlmacenamiento).delete();
                objetos += 1;
              }
            } catch (error: unknown) {
              this.logger.error(
                `No se pudo limpiar el adjunto pendiente ${adjunto._id.toString()}: ${(error as Error).message}`,
              );
            }
          }
        }

        this.logger.log(
          `Adjuntos de PQR abandonados: ${entradas} entradas y ${objetos} objetos eliminados`,
        );
      },
    );
  }

  /** Cloud Run scales to zero: catch up once the process is up (safe to repeat). */
  onApplicationBootstrap(): void {
    ejecutarAlArrancar(this.logger, 'limpieza de adjuntos de PQR', () =>
      this.limpiarPendientes(),
    );
  }
}
