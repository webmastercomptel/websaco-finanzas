// src/modules/publicacion-facturas/publicacion-facturas.listener.ts
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  LOTE_FACTURAS_PDF_CONFIRMADO,
  type LoteFacturasPdfConfirmadoEvent,
} from '../../common/eventos/lote-facturas-pdf-confirmado.event';
import { PublicacionFacturasService } from './publicacion-facturas.service';

/**
 * Bridges the domain event into this edge module. `LotesController` awaits
 * `emitAsync`, so this handler's own errors must NEVER propagate back to it
 * — publishing failing can never fail invoice confirmation. Every error is
 * caught and logged here, nothing is re-thrown.
 *
 * The same awaited handler also SENDS the lote it just enqueued
 * (`publicarAhora`): Cloud Run throttles CPU once the response goes out, so
 * the send has to finish before the confirm request returns. That makes the
 * confirm request as slow as the receiver (up to `FETCH_TIMEOUT_MS`, on a
 * cold start); the catch-all below covers the enqueue and the send alike.
 */
@Injectable()
export class PublicacionFacturasListener {
  private readonly logger = new Logger(PublicacionFacturasListener.name);

  constructor(private readonly service: PublicacionFacturasService) {}

  @OnEvent(LOTE_FACTURAS_PDF_CONFIRMADO, { async: true, promisify: true })
  async manejar(evento: LoteFacturasPdfConfirmadoEvent): Promise<void> {
    try {
      // `encolar` is true only when the row exists (a skipped coproperty has
      // nothing to send); the row is written BEFORE any send attempt.
      if (await this.service.encolar(evento)) {
        await this.service.publicarAhora(evento.loteId);
      }
    } catch (err) {
      this.logger.error(
        `No se pudo publicar el lote ${evento.loteId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
