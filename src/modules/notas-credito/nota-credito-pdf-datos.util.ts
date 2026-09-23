import type { Model, Types } from 'mongoose';
import type { NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { SaldoInicialDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';
import { CUENTA_SIN_ASIGNAR } from '../facturacion/asiento.builder';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import type {
  DatosReciboImpresion,
  LineaAsientoImpresion,
} from '../../common/documentos/datos-impresion.types';
import {
  fechaNotaCredito,
  tipoAnclaDe,
  idAnclaDe,
} from './notas-credito.mapper';

// DIAN's own "Concepto de Corrección para Notas crédito" labels (Anexo
// 1.8-2021 §13.3.4) — see `MOTIVOS_NOTA_CREDITO`'s own docblock
// (`nota-credito.schema.ts`) for the full citation.
const MOTIVOS_LABELS: Record<string, string> = {
  devolucion_parcial:
    'Devolución parcial de los bienes y/o no aceptación parcial del servicio',
  anulacion_factura: 'Anulación de factura electrónica',
  descuento: 'Rebaja o descuento parcial o total',
  ajuste_precio: 'Ajuste de precio',
  otro: 'Otros',
};

export interface ModelosDatosImpresionNotaCredito {
  facturas: Model<FacturaDocument>;
  notasDebito: Model<NotaDebitoDocument>;
  saldosIniciales?: Model<SaldoInicialDocument>;
  conceptosCobro: Model<ConceptoCobroDocument>;
  inmuebles: Model<InmuebleDocument>;
  terceros: Model<TerceroDocument>;
  cuentasContables: Model<CuentaContableDocument>;
}

/**
 * Assembles everything the Nota Crédito PDF needs to draw its journal-entry
 * table — same shape and same drawing code as a Recibo's own print
 * (`contenidoRecibo`, `recibo-pdf.ts`; `tituloDocumento` is what tells the
 * renderer which one this is). Mirrors `construirDatosImpresionRecibo`
 * closely; the differences are real, not cosmetic:
 *
 *  - The débito side is one line PER CONCEPTO in `nota.distribution`, each
 *    debiting that concept's own `accountingIncomeAccount` — the SAME
 *    account originally credited when the concept was billed (a Factura
 *    line's own frozen account, or a Nota Débito's own
 *    `ConceptoCobro.cuentaCreditoId`, resolved fresh here since a Nota
 *    Débito never freezes it onto itself) — never a bank account (a Nota
 *    Crédito never moves cash) nor a single coproperty-wide "cuenta de
 *    devoluciones" lumping every concept together. Falls back to
 *    `cuentaDevoluciones` only for a concept with no income account
 *    configured — same role `cuentaCartera` plays as the fallback for an
 *    unattributed crédito line below. Mirrors exactly what
 *    `postearAsientoCreacion` now posts for real (`desgloseOrigen`, see
 *    `construirAsientoCruce`'s own docblock) — built from
 *    `nota.distribution` here too, for the same reason that function reads
 *    `dto.distribucion` rather than scaling to what got applied: even the
 *    portion that became anticipo already reversed revenue for that concept.
 *  - No discount handling — a Nota Crédito never carries one
 *    (`AplicacionCartera.discountApplied` is always 0 here).
 *  - Unlike a Recibo's leftover (redirected to a separate Nota de Anticipo,
 *    `sourceType: 'NA'`, once applied), EVERY application this Nota Crédito
 *    ever makes — at creation and any later deferred one via `aplicar()` —
 *    shares the same `sourceId`/`sourceType: 'NC'`. There is no "frozen at
 *    creation" snapshot to reconstruct here: the print always reflects the
 *    live `appliedAmount`/`unappliedAmount`, exactly like the JSON detail
 *    view already does.
 *
 * The anchor (`nota`'s own `tipoAnclaDe`/`idAnclaDe`) can be a Factura or a
 * Nota Débito; every OTHER `aplicacion` this note ever made via the
 * deferred `aplicar()` stays Factura-only (see that method's own docblock)
 * — same two-collection resolution `recibo-pdf-datos.util.ts` already uses
 * for its own FV+ND aplicaciones, branching on `aplicacion.documentType`.
 *
 * `aplicaciones` must be exactly what `findAplicacionesForSource('NC',
 * nota._id)` returns — every application this Nota Crédito ever made,
 * active only. Each one's `detalleConceptos` is what `crear()`/
 * `aplicarManual()`/`aplicarFifo()` persist for exactly this purpose (see
 * their own comments) — a note printed before that field existed falls back
 * to one generic row per application, same as a Recibo's identical fallback.
 */
export async function construirDatosImpresionNotaCredito(
  nota: NotaCreditoDocument,
  // No longer a field on the (now immutable) document —
  // `NotaCredito.unappliedAmount` is gone precisely so a Nota Crédito never
  // changes after issuance (see `SaldoDocumentoOrigen`'s own docblock). The
  // caller resolves it (same live source the JSON detail view reads) and
  // passes it in here.
  montoSinAplicar: number,
  aplicaciones: AplicacionCarteraDocument[],
  copropiedad: CopropiedadDocument,
  coPropertyId: Types.ObjectId,
  modelos: ModelosDatosImpresionNotaCredito,
  // Resolved by the caller (`NotasCreditoService.datosImpresion`, via
  // `TituloDocumentoService.resolverGenerico('NC', ...)`) — see
  // `construirDatosImpresionRecibo`'s identical parameter.
  tituloDocumento: string,
): Promise<DatosReciboImpresion> {
  const cuentaCartera = copropiedad.receivablesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaAnticipos = copropiedad.advancesAccount ?? CUENTA_SIN_ASIGNAR;
  const cuentaDevoluciones =
    copropiedad.creditNotesAccount ?? CUENTA_SIN_ASIGNAR;

  const anclaTipo = tipoAnclaDe(nota);
  const anclaId = idAnclaDe(nota);

  // Every Factura/Nota Débito this print needs a number/línea for: the
  // anchor (always — an application may have never touched it, e.g. its
  // outstandingBalance was already 0 at creation) plus every distinct
  // document an `aplicacion` actually targeted (never necessarily the
  // anchor — a later deferred application can spend the leftover against
  // any open Factura of the inmueble).
  const facturaIdsPorClave = new Map<string, Types.ObjectId>();
  const notaDebitoIdsPorClave = new Map<string, Types.ObjectId>();
  const saldoInicialIdsPorClave = new Map<string, Types.ObjectId>();
  const agregarId = (tipo: 'FV' | 'ND' | 'SI', id: Types.ObjectId): void => {
    const mapa =
      tipo === 'FV'
        ? facturaIdsPorClave
        : tipo === 'SI'
          ? saldoInicialIdsPorClave
          : notaDebitoIdsPorClave;
    mapa.set(id.toString(), id);
  };
  agregarId(anclaTipo, anclaId);
  for (const a of aplicaciones) agregarId(a.documentType, a.documentId);

  const [facturas, notasDebito, saldosIniciales, inmueble, tercero] =
    await Promise.all([
      facturaIdsPorClave.size
        ? modelos.facturas
            .find({
              coPropertyId,
              _id: { $in: [...facturaIdsPorClave.values()] },
            })
            .exec()
        : Promise.resolve([]),
      notaDebitoIdsPorClave.size
        ? modelos.notasDebito
            .find({
              coPropertyId,
              _id: { $in: [...notaDebitoIdsPorClave.values()] },
            })
            .exec()
        : Promise.resolve([]),
      saldoInicialIdsPorClave.size
        ? modelos.saldosIniciales
            ?.find({
              coPropertyId,
              _id: { $in: [...saldoInicialIdsPorClave.values()] },
            })
            .exec()
        : Promise.resolve([]),
      modelos.inmuebles.findOne({ _id: nota.inmuebleId, coPropertyId }).exec(),
      nota.terceroId
        ? modelos.terceros.findOne({ _id: nota.terceroId, coPropertyId }).exec()
        : Promise.resolve(null),
    ]);
  const facturaPorId = new Map(facturas.map((f) => [f._id.toString(), f]));
  const notaDebitoPorId = new Map(
    notasDebito.map((n) => [n._id.toString(), n]),
  );
  const saldoInicialPorId = new Map(
    (saldosIniciales ?? []).map((s) => [s._id.toString(), s]),
  );

  // A Nota Débito never freezes its own concepto's accounts onto itself
  // (unlike a Factura line) — resolve every involved ND's own concepto in
  // one batch, same populate-and-read pattern `NotasCreditoService`'s own
  // `resolverLineasAncla` uses.
  const conceptoIds = notasDebito.map((n) => n.conceptoId);
  const conceptos = conceptoIds.length
    ? await modelos.conceptosCobro
        .find({ coPropertyId, _id: { $in: conceptoIds } })
        .populate('cuentaCreditoId', 'code')
        .populate('cuentaDebitoId', 'code')
        .exec()
    : [];
  const conceptoPorId = new Map(conceptos.map((c) => [c._id.toString(), c]));
  /** This Nota Débito's own single concepto's cuenta de ingreso — the same
   *  fallback role `lineaFactura?.accountingIncomeAccount` plays for a
   *  Factura line below. */
  const cuentaIngresoDe = (n: NotaDebitoDocument): string | null => {
    const concepto = conceptoPorId.get(n.conceptoId.toString());
    return concepto ? codigoDeCuentaContable(concepto.cuentaCreditoId) : null;
  };
  const cuentaCarteraDe = (n: NotaDebitoDocument): string | null => {
    const concepto = conceptoPorId.get(n.conceptoId.toString());
    return concepto ? codigoDeCuentaContable(concepto.cuentaDebitoId) : null;
  };

  const lineas: LineaAsientoImpresion[] = [];
  const codigosUsados = new Set<string>([cuentaDevoluciones]);

  for (const aplicacion of aplicaciones) {
    // Empty on applications predating `detalleConceptos` — one generic row
    // for the whole amount rather than losing the line entirely, same
    // fallback as `construirDatosImpresionRecibo`'s identical one.
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
    } else if (aplicacion.documentType === 'SI') {
      // Only ever reachable when THIS aplicación is the note's own anchor
      // (the deferred `aplicar()` path never targets a Saldo Inicial —
      // see this function's own docblock). Already frozen per-línea, same
      // as a Factura.
      const saldoInicial = saldoInicialPorId.get(
        aplicacion.documentId.toString(),
      );
      for (const detalle of detalles) {
        const lineaSI = detalle.conceptoId
          ? saldoInicial?.lines.find((l) =>
              l.conceptoId.equals(detalle.conceptoId),
            )
          : undefined;
        const codigo = lineaSI?.accountingReceivableAccount ?? cuentaCartera;
        codigosUsados.add(codigo);
        lineas.push({
          cuentaCodigo: codigo,
          cuentaNombre: '',
          tipoDocumento: 'SI',
          numeroDocumento: saldoInicial?.number ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    } else {
      // Only ever reachable when THIS aplicación is the note's own anchor
      // (the deferred `aplicar()` path never targets a Nota Débito — see
      // this function's own docblock).
      const notaDebito = notaDebitoPorId.get(aplicacion.documentId.toString());
      const codigo = notaDebito
        ? (cuentaCarteraDe(notaDebito) ?? cuentaCartera)
        : cuentaCartera;
      codigosUsados.add(codigo);
      for (const detalle of detalles) {
        lineas.push({
          cuentaCodigo: codigo,
          cuentaNombre: '',
          tipoDocumento: 'ND',
          numeroDocumento: notaDebito?.number ?? null,
          debito: 0,
          credito: detalle.monto,
        });
      }
    }
  }

  if (montoSinAplicar > 0) {
    codigosUsados.add(cuentaAnticipos);
    lineas.push({
      cuentaCodigo: cuentaAnticipos,
      cuentaNombre: '',
      tipoDocumento: null,
      numeroDocumento: null,
      debito: 0,
      credito: montoSinAplicar,
    });
  }

  // Débito per concepto — see this function's own docblock on why
  // `nota.distribution` (not a scaled/applied amount) is the right source.
  const notaDebitoAncla =
    anclaTipo === 'ND' ? notaDebitoPorId.get(anclaId.toString()) : undefined;
  const facturaAncla =
    anclaTipo === 'FV' ? facturaPorId.get(anclaId.toString()) : undefined;
  const saldoInicialAncla =
    anclaTipo === 'SI' ? saldoInicialPorId.get(anclaId.toString()) : undefined;
  for (const linea of nota.distribution) {
    const lineaFactura = facturaAncla?.lines.find((l) =>
      l.conceptoId.equals(linea.conceptoId),
    );
    // A Saldo Inicial's own `accountingIncomeAccount` is deliberately
    // always `null` (see its schema docblock — nothing was ever posted as
    // income in this system for an opening balance), so this falls straight
    // through to `cuentaDevoluciones`, same as an unconfigured Factura/ND
    // concept.
    const lineaSaldoInicial = saldoInicialAncla?.lines.find((l) =>
      l.conceptoId.equals(linea.conceptoId),
    );
    const codigo =
      lineaFactura?.accountingIncomeAccount ??
      lineaSaldoInicial?.accountingIncomeAccount ??
      (notaDebitoAncla ? cuentaIngresoDe(notaDebitoAncla) : null) ??
      cuentaDevoluciones;
    codigosUsados.add(codigo);
    lineas.push({
      cuentaCodigo: codigo,
      cuentaNombre: '',
      tipoDocumento: null,
      numeroDocumento: null,
      debito: linea.amount,
      credito: 0,
    });
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
    tituloDocumento,
    numeroCompleto: nota.fullNumber,
    fecha: fechaNotaCredito(nota),
    inmuebleCodigo: inmueble?.code ?? '—',
    titularNombre: tercero?.name ?? '—',
    concepto: nota.notes ?? MOTIVOS_LABELS[nota.reason] ?? nota.reason,
    monto: nota.totalAmount,
    lineas,
  };
}
