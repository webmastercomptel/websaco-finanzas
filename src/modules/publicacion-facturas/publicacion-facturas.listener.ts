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
 */
@Injectable()
export class PublicacionFacturasListener {
  private readonly logger = new Logger(PublicacionFacturasListener.name);

  constructor(private readonly service: PublicacionFacturasService) {}

  @OnEvent(LOTE_FACTURAS_PDF_CONFIRMADO, { async: true, promisify: true })
  async manejar(evento: LoteFacturasPdfConfirmadoEvent): Promise<void> {
    try {
      await this.service.encolar(evento);
    } catch (err) {
      this.logger.error(
        `No se pudo encolar la publicación del lote ${evento.loteId}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
