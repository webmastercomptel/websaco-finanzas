import type { Model, Types } from 'mongoose';
import type { NotaAnticipoDocument } from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';
import { CUENTA_SIN_ASIGNAR } from '../facturacion/asiento.builder';
import type {
  DatosReciboImpresion,
  LineaAsientoImpresion,
} from '../../common/pdf/recibo-pdf';

export interface ModelosDatosImpresionNotaAnticipo {
  facturas: Model<FacturaDocument>;
  notasDebito: Model<NotaDebitoDocument>;
  recibos: Model<ReciboDocument>;
  inmuebles: Model<InmuebleDocument>;
  terceros: Model<TerceroDocument>;
  cuentasContables: Model<CuentaContableDocument>;
}

/**
 * Assembles what the Nota de Anticipo PDF needs to draw its journal-entry
 * table — same shared layout `contenidoRecibo` already draws for a Recibo
 * or a Nota Crédito (`tituloDocumento` picks which). Mirrors
 * `construirDatosImpresionRecibo`'s crédito-per-concepto loop exactly (a
 * Nota de Anticipo settles cartera the same way a Recibo does — no
 * per-concepto income reversal the way a Nota Crédito's own débito side
 * has), with two real differences:
 *
 *  - The débito side is always ONE line, `cuentaAnticipos` for the FULL
 *    `nota.appliedAmount` — exactly what
 *    `construirMovimientosAplicacionAnticipo` posts (see that function's own
 *    docblock: the debit is never split, even when the credit side is). No
 *    bank line (no new cash moved) and no leftover-anticipo line (a Nota de
 *    Anticipo has no `montoSinAplicar` of its own — see its schema's own
 *    docblock, `appliedAmount` is the whole document).
 *  - No discount handling — same reasoning
 *    `construirDatosImpresionNotaCredito` already documents for its own
 *    case: `construirMovimientosAplicacionAnticipo` has no `descuento`
 *    parameter at all, so `AplicacionCartera.discountApplied` never affects
 *    this entry even if the underlying application happened to qualify for
 *    one.
 *
 * `aplicaciones` must be exactly what `NotasAnticipoService.findAplicaciones`
 * returns — every application THIS Nota de Anticipo made, active only.
 * `concepto` names the origin Recibo (`reciboOrigen.fullNumber`), the same
 * thing this document's own "Recibo de Origen" link shows in the JSON detail
 * view — a Nota de Anticipo has no `notes`/`reason` field of its own to draw
 * from, unlike a Recibo or a Nota Crédito.
 */
export async function construirDatosImpresionNotaAnticipo(
  nota: NotaAnticipoDocument,
  aplicaciones: AplicacionCarteraDocument[],
  copropiedad: CopropiedadDocument,
  coPropertyId: Types.ObjectId,
  modelos: ModelosDatosImpresionNotaAnticipo,
): Promise<DatosReciboImpresion> {
  const cuentaCartera = copropiedad.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaAnticipos = copropiedad.advancesAccount ?? CUENTA_SIN_ASIGNAR;

  const facturaIds = aplicaciones
    .filter((a) => a.documentType === 'FV')
    .map((a) => a.documentId);
  const notaIds = aplicaciones
    .filter((a) => a.documentType === 'ND')
    .map((a) => a.documentId);

  const [facturas, notas, reciboOrigen, inmueble, tercero] = await Promise.all([
    facturaIds.length > 0
      ? modelos.facturas.find({ _id: { $in: facturaIds }, coPropertyId }).exec()
      : Promise.resolve([]),
    notaIds.length > 0
      ? modelos.notasDebito.find({ _id: { $in: notaIds }, coPropertyId }).exec()
      : Promise.resolve([]),
    modelos.recibos.findOne({ _id: nota.reciboOrigenId, coPropertyId }).exec(),
    modelos.inmuebles.findOne({ _id: nota.inmuebleId, coPropertyId }).exec(),
    nota.terceroId
      ? modelos.terceros.findOne({ _id: nota.terceroId, coPropertyId }).exec()
      : Promise.resolve(null),
  ]);

  const facturaPorId = new Map(facturas.map((f) => [f._id.toString(), f]));
  const notaPorId = new Map(notas.map((n) => [n._id.toString(), n]));

  const lineas: LineaAsientoImpresion[] = [
    {
      cuentaCodigo: cuentaAnticipos,
      cuentaNombre: '',
      tipoDocumento: null,
      numeroDocumento: null,
      debito: nota.appliedAmount,
      credito: 0,
    },
  ];
  const codigosUsados = new Set<string>([cuentaAnticipos]);

  for (const aplicacion of aplicaciones) {
    // Empty on applications predating `detalleConceptos` — one generic row
    // for the whole amount rather than losing the line entirely, same
    // fallback `construirDatosImpresionRecibo` uses.
    const detalles =
      aplicacion.detalleConceptos.length > 0
        ? aplicacion.detalleConceptos
        : [
            {
              conceptoId: null,
              conceptName: 'Aplicación',
              monto: aplicacion.amountApplied,
            },
          ];

    if (aplicacion.documentType === 'FV') {
      const factura = facturaPorId.get(aplicacion.documentId.toString());
      for (const detalle of detalles) {
        const lineaFactura = detalle.conceptoId
          ? factura?.lines.find((l) => l.conceptoId.equals(detalle.conceptoId))
          : undefined;
        const codigo =
          lineaFactura?.accountingReceivableAccount ?? cuentaCartera;
        codigosUsados.add(codigo);
        lineas.push({
          cuentaCodigo: codigo,
          cuentaNombre: '',
          tipoDocumento: 'FV',
          numeroDocumento: factura?.number ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    } else {
      const notaDebito = notaPorId.get(aplicacion.documentId.toString());
      codigosUsados.add(cuentaCartera);
      for (const detalle of detalles) {
        lineas.push({
          cuentaCodigo: cuentaCartera,
          cuentaNombre: '',
          tipoDocumento: 'ND',
          numeroDocumento: notaDebito?.number ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    }
  }

  const cuentas = await modelos.cuentasContables
    .find({ coPropertyId, code: { $in: [...codigosUsados] } })
    .exec();
  const nombrePorCodigo = new Map(cuentas.map((c) => [c.code, c.name]));
  for (const linea of lineas) {
    linea.cuentaNombre =
      nombrePorCodigo.get(linea.cuentaCodigo) ?? linea.cuentaCodigo;
  }

  return {
    tituloDocumento: 'Nota de Anticipo',
    numeroCompleto: nota.fullNumber,
    fecha: nota.issueDate,
    inmuebleCodigo: inmueble?.code ?? '—',
    titularNombre: tercero?.name ?? '—',
    concepto: reciboOrigen
      ? `Aplicación de anticipo — recibo ${reciboOrigen.fullNumber}`
      : 'Aplicación de anticipo',
    monto: nota.appliedAmount,
    lineas,
  };
}
