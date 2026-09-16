import { BadRequestException } from '@nestjs/common';
import type { Types } from 'mongoose';

export interface LineaDistribucionSolicitada {
  conceptoId: string;
  monto: number;
}

export interface LineaFacturaParaCap {
  conceptoId: Types.ObjectId;
  totalAmount: number;
}

/**
 * Validates a Nota Crédito's requested `distribucion` against its anchor
 * invoice's own lines (design §6): the distribution must sum to EXACTLY
 * `montoTotal`, and no line may exceed what that concepto amounts to on the
 * invoice — the mockup's per-concepto "Max" cap, summed across every line
 * of the invoice that shares that concepto — MINUS whatever `yaCreditado`
 * (every OTHER active Nota Crédito against this same anchor invoice already
 * credited for that concepto; see `NotasCreditoService.crear()`'s own call
 * site for how that map is built). Without that subtraction, each note is
 * validated in isolation and a concept can be credited past its own face
 * value by simply issuing a second note — the cap is per-concepto-on-this-
 * invoice, cumulative across every note that has ever touched it, not
 * per-note (a real gap this parameter closes: a duplicate/accidental
 * resubmission of the same correction used to sail through unblocked,
 * manufacturing a client anticipo out of nothing and reversing revenue a
 * second time). Deliberately NOT the invoice's live `outstandingBalance` /
 * `CarteraPorDocumento.saldoPendiente`: those also drop when a Recibo pays
 * the invoice down, and crediting an ALREADY-PAID concept is the designed
 * "convert this payment into anticipo" path (`crear()`'s own
 * `Math.min(montoTotal, saldoAncla.saldoPendiente)`) — capping against that
 * would block a legitimate refund of a fully-paid invoice. Only a VOIDED
 * note's own past credit must be excluded from `yaCreditado` — anular()
 * fully reverses it, so the concept's face value opens back up.
 *
 * Throws `BadRequestException` naming which check failed and by how much
 * (design §8: "distribution sum/cap mismatches named specifically"); never
 * partially applies — the caller runs this before touching the database,
 * all-or-nothing.
 */
export function validarDistribucionNotaCredito(
  distribucion: LineaDistribucionSolicitada[],
  montoTotal: number,
  lineasFactura: LineaFacturaParaCap[],
  yaCreditadoPorConcepto: Map<string, number> = new Map(),
): void {
  const suma = distribucion.reduce((acc, linea) => acc + linea.monto, 0);
  if (suma !== montoTotal) {
    throw new BadRequestException(
      `La distribución (${suma}) no coincide con el monto total de la nota crédito (${montoTotal})`,
    );
  }

  const topePorConcepto = new Map<string, number>();
  for (const linea of lineasFactura) {
    const id = linea.conceptoId.toString();
    topePorConcepto.set(id, (topePorConcepto.get(id) ?? 0) + linea.totalAmount);
  }

  const solicitadoPorConcepto = new Map<string, number>();
  for (const linea of distribucion) {
    solicitadoPorConcepto.set(
      linea.conceptoId,
      (solicitadoPorConcepto.get(linea.conceptoId) ?? 0) + linea.monto,
    );
  }

  for (const [conceptoId, montoSolicitado] of solicitadoPorConcepto) {
    const topeFactura = topePorConcepto.get(conceptoId) ?? 0;
    const yaCreditado = yaCreditadoPorConcepto.get(conceptoId) ?? 0;
    const topeDisponible = topeFactura - yaCreditado;
    if (montoSolicitado > topeDisponible) {
      throw new BadRequestException(
        `El concepto ${conceptoId} no admite acreditar ${montoSolicitado}: ` +
          `la factura ancla lo cobra por ${topeFactura} y ya se acreditaron ` +
          `${yaCreditado} en otras notas crédito activas (disponible: ${topeDisponible})`,
      );
    }
  }
}
