// src/modules/documentos/documentos-huerfanos.service.ts
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
  ArchivoDocumento,
  type ArchivoDocumentoDocument,
} from '../../database/schemas/administracion/documento-archivo.schema';
import { DocumentosAlmacenService } from './documentos-almacen.service';

/**
 * Grace period before an unconfirmed upload counts as abandoned: one hour, as in
 * the system this was ported from. It must stay well above the signed upload
 * URL's life (`VIGENCIA_URL_MS`, 15 minutes; a test pins the relation): once the URL has expired nobody
 * can still be mid-upload, so deleting the record cannot race a live PUT.
 */
export const GRACIA_SUBIDAS_PENDIENTES_MS = 60 * 60 * 1000;

/**
 * Nightly cleanup of abandoned uploads: the browser asked for a signed URL (so a
 * `pendiente` record exists) but never confirmed. This is the ONE place that
 * deletes records and Storage objects without a person asking.
 *
 * SAFETY, in order of importance (each one has a test):
 * 1. It never lists the bucket. It only looks at `pendiente` RECORDS, so it
 *    cannot reach an object nobody registered — financial documents, zone
 *    images and PQR attachments are invisible to it.
 * 2. It only touches records that are `pendiente` AND older than the grace. A
 *    `listo` record is never selected, and a confirmation that lands mid-run
 *    wins: the delete re-checks `estado: 'pendiente'` atomically per record.
 * 3. The record is deleted FIRST and its object only if that delete really
 *    removed it, so an object is never deleted while a record still points at it.
 * 4. The object goes through `DocumentosAlmacenService.eliminar`, which refuses
 *    any path outside `documentos-administracion/`, even if a record were
 *    corrupted to point at another prefix.
 *
 * It spans ALL coproperties on purpose: housekeeping with no request and no
 * tenant, and the tenancy law governs request-scoped reads. Timezone caveat:
 * `EVERY_DAY_AT_3AM` is the SERVER's local time; Cloud Run runs in UTC, so it
 * fires at 22:00 in Bogotá. Harmless for a cleanup, but not "3 AM" locally.
 */
@Injectable()
export class DocumentosHuerfanosService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentosHuerfanosService.name);

  constructor(
    @InjectModel(ArchivoDocumento.name)
    private readonly archivos: Model<ArchivoDocumentoDocument>,
    private readonly almacen: DocumentosAlmacenService,
    private readonly lock: LockService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async limpiarPendientes(): Promise<void> {
    await ejecutarTareaProgramada(
      this.lock,
      this.logger,
      { clave: 'cron:documentos:huerfanos', ttlMs: 1_800_000 },
      async () => {
        const limite = new Date(Date.now() - GRACIA_SUBIDAS_PENDIENTES_MS);
        const filtro = {
          estado: 'pendiente' as const,
          createdAt: { $lt: limite },
        };

        const abandonados = await this.archivos
          .find(filtro)
          .select('_id rutaAlmacenamiento')
          .lean()
          .exec();

        let registros = 0;
        let objetos = 0;
        for (const archivo of abandonados) {
          try {
            const borrado = await this.archivos
              .deleteOne({ _id: archivo._id, ...filtro })
              .exec();
            // Confirmed (or already gone) since we looked: leave its object alone.
            if (borrado.deletedCount !== 1) continue;
            registros += 1;
            if (
              archivo.rutaAlmacenamiento &&
              (await this.almacen.eliminar(archivo.rutaAlmacenamiento))
            ) {
              objetos += 1;
            }
          } catch (error: unknown) {
            this.logger.error(
              `No se pudo limpiar la subida pendiente ${archivo._id.toString()}: ${(error as Error).message}`,
            );
          }
        }

        this.logger.log(
          `Subidas de documentos abandonadas: ${registros} registros y ${objetos} objetos eliminados`,
        );
      },
    );
  }

  /**
   * Cloud Run scales to zero, so the 3 AM cron only fires if an instance happens
   * to be awake: catch up once the process is up. Safe to repeat: the grace
   * period and the per-record condition make a second pass a no-op.
   */
  onApplicationBootstrap(): void {
    ejecutarAlArrancar(this.logger, 'limpieza de subidas de documentos', () =>
      this.limpiarPendientes(),
    );
  }
}
