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
 * of the invoice that shares that concepto. Throws `BadRequestException`
 * naming which check failed and by how much (design §8: "distribution
 * sum/cap mismatches named specifically"); never partially applies — the
 * caller runs this before touching the database, all-or-nothing.
 */
export function validarDistribucionNotaCredito(
  distribucion: LineaDistribucionSolicitada[],
  montoTotal: number,
  lineasFactura: LineaFacturaParaCap[],
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

  for (const linea of distribucion) {
    const tope = topePorConcepto.get(linea.conceptoId) ?? 0;
    if (linea.monto > tope) {
      throw new BadRequestException(
        `El concepto ${linea.conceptoId} no admite acreditar ${linea.monto}: ` +
          `la factura ancla solo lo cobra por ${tope}`,
      );
    }
  }
}
