import type { Model, Types } from 'mongoose';
import type { SaldoInicialAnticipoDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import type { SaldoDocumentoOrigenDocument } from '../../database/schemas/recibos/saldo-documento-origen.schema';

/** An active Saldo Inicial de Anticipo together with its LIVE unapplied
 *  balance. */
export interface SaldoInicialAnticipoVigente {
  doc: SaldoInicialAnticipoDocument;
  saldoDisponible: number;
}

/**
 * The opening anticipos of the given units that still have something to
 * apply: `activo` documents whose live `SaldoDocumentoOrigen.saldoDisponible`
 * is above zero.
 *
 * A Saldo Inicial de Anticipo is an anticipo exactly like a Recibo's
 * unapplied balance, so every "anticipos pendientes" figure (estado de
 * cuenta, the factura PDF's amount-to-pay, the conciliación) goes through
 * this one definition instead of re-deriving it. The balance is read from
 * the same ledger the Nota de Anticipo decrements — never from
 * `montoOriginal`.
 */
export async function buscarSaldosInicialesAnticipoVigentes(
  saldosInicialesAnticipo: Model<SaldoInicialAnticipoDocument>,
  saldoDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
  copropiedadId: Types.ObjectId,
  inmuebleIds: Types.ObjectId[],
): Promise<SaldoInicialAnticipoVigente[]> {
  if (inmuebleIds.length === 0) return [];
  const documentos = await saldosInicialesAnticipo
    .find({
      copropiedadId,
      inmuebleId: { $in: inmuebleIds },
      estado: 'activo',
    })
    .exec();
  if (documentos.length === 0) return [];

  const saldos = await saldoDocumentoOrigen
    .find({
      copropiedadId,
      tipoDocumento: 'SI',
      documentoId: { $in: documentos.map((d) => d._id) },
    })
    .exec();
  const saldoPorId = new Map(
    saldos.map((s) => [s.documentoId.toString(), s.saldoDisponible]),
  );

  return documentos
    .map((doc) => ({
      doc,
      saldoDisponible: saldoPorId.get(doc._id.toString()) ?? 0,
    }))
    .filter(({ saldoDisponible }) => saldoDisponible > 0);
}
