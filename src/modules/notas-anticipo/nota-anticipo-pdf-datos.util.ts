import type { Model, Types } from 'mongoose';
import type { NotaAnticipoDocument } from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { SaldoInicialAnticipoDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial-anticipo.schema';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';
import { CUENTA_SIN_ASIGNAR } from '../facturacion/asiento.builder';
import { emisorDe } from '../../common/documentos/emisor.util';
import type {
  DatosReciboImpresion,
  LineaAsientoImpresion,
} from '../../common/documentos/datos-impresion.types';

export interface ModelosDatosImpresionNotaAnticipo {
  facturas: Model<FacturaDocument>;
  notasDebito: Model<NotaDebitoDocument>;
  recibos: Model<ReciboDocument>;
  saldosInicialesAnticipo?: Model<SaldoInicialAnticipoDocument>;
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
 * `concepto` names the origin document (`reciboOrigen.fullNumber`, or
 * `saldoInicialAnticipoOrigen.fullNumber` when `nota.origenTipo` is `'SI'`),
 * the same thing this document's own "Origen" link shows in the JSON detail
 * view — a Nota de Anticipo has no `notes`/`reason` field of its own to draw
 * from, unlike a Recibo or a Nota Crédito.
 */
export async function construirDatosImpresionNotaAnticipo(
  nota: NotaAnticipoDocument,
  aplicaciones: AplicacionCarteraDocument[],
  copropiedad: CopropiedadDocument,
  copropiedadId: Types.ObjectId,
  modelos: ModelosDatosImpresionNotaAnticipo,
  // Resolved by the caller (`NotasAnticipoService.datosImpresion`, via
  // `TituloDocumentoService.resolverGenerico('NA', ...)`) — see
  // `construirDatosImpresionRecibo`'s identical parameter.
  tituloDocumento: string,
): Promise<DatosReciboImpresion> {
  const cuentaCartera = copropiedad.cuentaContableCartera ?? CUENTA_SIN_ASIGNAR;
  const cuentaAnticipos = copropiedad.cuentaAnticipos ?? CUENTA_SIN_ASIGNAR;

  const facturaIds = aplicaciones
    .filter((a) => a.tipoDocumento === 'FV')
    .map((a) => a.documentoId);
  const notaIds = aplicaciones
    .filter((a) => a.tipoDocumento === 'ND')
    .map((a) => a.documentoId);

  const [
    facturas,
    notas,
    reciboOrigen,
    saldoInicialAnticipoOrigen,
    inmueble,
    tercero,
  ] = await Promise.all([
    facturaIds.length > 0
      ? modelos.facturas
          .find({ _id: { $in: facturaIds }, copropiedadId })
          .exec()
      : Promise.resolve([]),
    notaIds.length > 0
      ? modelos.notasDebito
          .find({ _id: { $in: notaIds }, copropiedadId })
          .exec()
      : Promise.resolve([]),
    nota.origenTipo === 'SI'
      ? Promise.resolve(null)
      : modelos.recibos
          .findOne({ _id: nota.reciboOrigenId, copropiedadId })
          .exec(),
    nota.origenTipo === 'SI'
      ? (modelos.saldosInicialesAnticipo
          ?.findOne({ _id: nota.reciboOrigenId, copropiedadId })
          .exec() ?? Promise.resolve(null))
      : Promise.resolve(null),
    modelos.inmuebles.findOne({ _id: nota.inmuebleId, copropiedadId }).exec(),
    nota.terceroId
      ? modelos.terceros.findOne({ _id: nota.terceroId, copropiedadId }).exec()
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
      debito: nota.montoAplicado,
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
              nombreConcepto: 'Aplicación',
              monto: aplicacion.montoAplicado,
            },
          ];

    if (aplicacion.tipoDocumento === 'FV') {
      const factura = facturaPorId.get(aplicacion.documentoId.toString());
      for (const detalle of detalles) {
        const lineaFactura = detalle.conceptoId
          ? factura?.lineas.find((l) => l.conceptoId.equals(detalle.conceptoId))
          : undefined;
        const codigo = lineaFactura?.cuentaCartera ?? cuentaCartera;
        codigosUsados.add(codigo);
        lineas.push({
          cuentaCodigo: codigo,
          cuentaNombre: '',
          tipoDocumento: 'FV',
          numeroDocumento: factura?.numero ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    } else {
      const notaDebito = notaPorId.get(aplicacion.documentoId.toString());
      codigosUsados.add(cuentaCartera);
      for (const detalle of detalles) {
        lineas.push({
          cuentaCodigo: cuentaCartera,
          cuentaNombre: '',
          tipoDocumento: 'ND',
          numeroDocumento: notaDebito?.numero ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    }
  }

  const cuentas = await modelos.cuentasContables
    .find({ copropiedadId, codigo: { $in: [...codigosUsados] } })
    .exec();
  const nombrePorCodigo = new Map(cuentas.map((c) => [c.codigo, c.nombre]));
  for (const linea of lineas) {
    linea.cuentaNombre =
      nombrePorCodigo.get(linea.cuentaCodigo) ?? linea.cuentaCodigo;
  }

  return {
    tituloDocumento,
    numeroCompleto: nota.numeroCompleto,
    fecha: nota.fechaEmision,
    inmuebleCodigo: inmueble?.codigo ?? '—',
    titularNombre: tercero?.nombre ?? '—',
    concepto: saldoInicialAnticipoOrigen
      ? `Aplicación de anticipo — saldo inicial ${saldoInicialAnticipoOrigen.numeroCompleto}`
      : reciboOrigen
        ? `Aplicación de anticipo — recibo ${reciboOrigen.numeroCompleto}`
        : 'Aplicación de anticipo',
    monto: nota.montoAplicado,
    lineas,
    totalDebito: lineas.reduce((acc, l) => acc + l.debito, 0),
    totalCredito: lineas.reduce((acc, l) => acc + l.credito, 0),
    emisor: emisorDe(copropiedad),
    logoFilas: copropiedad.mostrarLogo ? [{}] : [],
  };
}
