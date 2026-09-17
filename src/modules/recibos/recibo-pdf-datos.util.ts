import type { Model, Types } from 'mongoose';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';
import { CUENTA_SIN_ASIGNAR } from '../facturacion/asiento.builder';
import type {
  DatosReciboImpresion,
  LineaAsientoImpresion,
} from '../../common/pdf/recibo-pdf';

export interface ModelosDatosImpresionRecibo {
  facturas: Model<FacturaDocument>;
  notasDebito: Model<NotaDebitoDocument>;
  inmuebles: Model<InmuebleDocument>;
  terceros: Model<TerceroDocument>;
  cuentasContables: Model<CuentaContableDocument>;
}

/**
 * Assembles everything the Recibo PDF needs to draw its journal-entry table
 * — one row per cargo this Recibo actually settled (resolving each
 * concepto's own accounting code from its target Factura's frozen `lines`,
 * same account `ejecutarAplicacionManual`/`ejecutarAplicacionFifo` credited
 * at application time — see `cruce.util.ts`), a leftover-anticipo row when
 * this Recibo generated one, and the bank debit row — plus the inmueble/
 * titular header info the print's own layout needs. No PDF drawing here;
 * `contenidoRecibo` (recibo-pdf.ts) only draws what this returns.
 *
 * `aplicaciones` must be exactly what `findAplicacionesForSource('RC',
 * recibo._id)` returns — every application THIS Recibo made, active only.
 * The anticipo row is derived from `receivedAmount - sum(amountApplied -
 * discountApplied)` — cash only, never from `recibo.unappliedAmount`: a
 * later Nota de Anticipo can reduce that live balance further, but this
 * Recibo's own printed receipt must always show what IT posted at creation,
 * unaffected by what happened to the leftover afterward (that belongs on
 * the Nota de Anticipo's own PDF). `discountApplied` must be subtracted
 * back out of `sum(amountApplied)` before deriving anticipo — that sum is
 * the GROSS amount credited to cartera (real cash plus any early-payment
 * discount, see `evaluarAplicacionConDescuento` in `cruce.util.ts`), so
 * leaving the discount in would understate the anticipo by exactly that
 * amount. A balancing débito line for the discount (mirroring
 * `construirAsientoCruce`'s own `descuento` debit) is added when this
 * Recibo absorbed one.
 *
 * The leftover line itself credits `advancesAccount` OR
 * `otherIncomeCreditAccount` depending on `recibo.otherIncomeAmount` — same
 * choice `postearAsientoRecibo` made at creation (`destinoSobrante`), never
 * unconditionally Anticipos.
 */
export async function construirDatosImpresionRecibo(
  recibo: ReciboDocument,
  aplicaciones: AplicacionCarteraDocument[],
  copropiedad: CopropiedadDocument,
  coPropertyId: Types.ObjectId,
  modelos: ModelosDatosImpresionRecibo,
): Promise<DatosReciboImpresion> {
  const cuentaCartera = copropiedad.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaAnticipos = copropiedad.advancesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaOtrosIngresos =
    copropiedad.otherIncomeCreditAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaDescuentos =
    copropiedad.discountsDebitAccount ?? CUENTA_SIN_ASIGNAR;

  const facturaIds = aplicaciones
    .filter((a) => a.documentType === 'FV')
    .map((a) => a.documentId);
  const notaIds = aplicaciones
    .filter((a) => a.documentType === 'ND')
    .map((a) => a.documentId);

  const [facturas, notas, inmueble, tercero] = await Promise.all([
    facturaIds.length > 0
      ? modelos.facturas.find({ _id: { $in: facturaIds }, coPropertyId }).exec()
      : Promise.resolve([]),
    notaIds.length > 0
      ? modelos.notasDebito.find({ _id: { $in: notaIds }, coPropertyId }).exec()
      : Promise.resolve([]),
    modelos.inmuebles.findOne({ _id: recibo.inmuebleId, coPropertyId }).exec(),
    modelos.terceros.findOne({ _id: recibo.terceroId, coPropertyId }).exec(),
  ]);

  const facturaPorId = new Map(facturas.map((f) => [f._id.toString(), f]));
  const notaPorId = new Map(notas.map((n) => [n._id.toString(), n]));

  const lineas: LineaAsientoImpresion[] = [];
  const codigosUsados = new Set<string>([recibo.destinationAccount]);

  for (const aplicacion of aplicaciones) {
    // Empty on applications predating `detalleConceptos` — one generic row
    // for the whole amount rather than losing the line entirely (see that
    // field's own schema comment).
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
      const nota = notaPorId.get(aplicacion.documentId.toString());
      codigosUsados.add(cuentaCartera);
      for (const detalle of detalles) {
        lineas.push({
          cuentaCodigo: cuentaCartera,
          cuentaNombre: '',
          tipoDocumento: 'ND',
          numeroDocumento: nota?.number ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    }
  }

  // `amountApplied` is the FULL amount credited to cartera — real cash plus
  // any early-payment discount it absorbed (`discountApplied`), same
  // "gross" figure `construirAsientoCruce` credits to `cuentaCartera` — see
  // `evaluarAplicacionConDescuento` (cruce.util.ts). The leftover anticipo
  // is real CASH only, so the discount portion must come back out here too,
  // or it silently understates the anticipo by exactly the discount amount.
  const totalAplicado = aplicaciones.reduce(
    (acc, a) => acc + a.amountApplied,
    0,
  );
  const totalDescuento = aplicaciones.reduce(
    (acc, a) => acc + (a.discountApplied ?? 0),
    0,
  );
  const anticipo = recibo.receivedAmount - (totalAplicado - totalDescuento);
  if (anticipo > 0) {
    // A Recibo never splits its leftover between the two — `destinoSobrante`
    // is one choice for the whole surplus (see `RecibosService.crear`'s own
    // `enviarAOtrosIngresos`) — so `otherIncomeAmount > 0` alone decides
    // which account this ONE line credits. Same account this Recibo's own
    // creation asiento actually posted to (`postearAsientoRecibo`), never
    // unconditionally Anticipos as before.
    const cuentaLeftover =
      recibo.otherIncomeAmount > 0 ? cuentaOtrosIngresos : cuentaAnticipos;
    codigosUsados.add(cuentaLeftover);
    lineas.push({
      cuentaCodigo: cuentaLeftover,
      cuentaNombre: '',
      tipoDocumento: null,
      numeroDocumento: null,
      debito: 0,
      credito: anticipo,
    });
  }

  // Balancing débito for the discount credited to cartera above — the real
  // posted asiento always carries this line (`construirAsientoCruce`'s own
  // `descuento` debit); the printed receipt must show it too, both to
  // explain why the anticipo isn't larger and to keep this table's own
  // débito/crédito totals meaningful.
  if (totalDescuento > 0) {
    codigosUsados.add(cuentaDescuentos);
    lineas.push({
      cuentaCodigo: cuentaDescuentos,
      cuentaNombre: '',
      tipoDocumento: null,
      numeroDocumento: null,
      debito: totalDescuento,
      credito: 0,
    });
  }

  lineas.push({
    cuentaCodigo: recibo.destinationAccount,
    cuentaNombre: '',
    tipoDocumento: null,
    numeroDocumento: null,
    debito: recibo.receivedAmount,
    credito: 0,
  });

  const cuentas = await modelos.cuentasContables
    .find({ coPropertyId, code: { $in: [...codigosUsados] } })
    .exec();
  const nombrePorCodigo = new Map(cuentas.map((c) => [c.code, c.name]));
  for (const linea of lineas) {
    linea.cuentaNombre =
      nombrePorCodigo.get(linea.cuentaCodigo) ?? linea.cuentaCodigo;
  }

  return {
    tituloDocumento: 'Recibo de Caja',
    numeroCompleto: recibo.fullNumber,
    fecha: recibo.receivedDate,
    inmuebleCodigo: inmueble?.code ?? '—',
    titularNombre: tercero?.name ?? '—',
    concepto: recibo.notes ?? 'Pago recibido',
    monto: recibo.receivedAmount,
    lineas,
  };
}
