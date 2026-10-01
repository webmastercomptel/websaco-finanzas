import type {
  LoteFacturacion as LoteContract,
  LoteFacturacionDetalle,
  FacturaPreliminar as FacturaPreliminarContract,
} from '../../contracts';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { FacturaPreliminar } from '../../database/schemas/facturacion/lote-facturacion.schema';
import { titularDe, lineaDe } from './facturas.mapper';

/**
 * Maps a billing-run document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md, same pattern as
 * `toFactura`.
 */
export const toLote = (doc: LoteFacturacionDocument): LoteContract => ({
  id: doc._id.toString(),
  numero: doc.numero,
  estado: doc.estado,
  fechaFacturacion: doc.fechaFacturacion.toISOString(),
  fechaVencimiento: doc.fechaVencimiento.toISOString(),
  periodoDesde: doc.periodoDesde.toISOString(),
  periodoHasta: doc.periodoHasta.toISOString(),
  descuentoProntoPago: doc.descuentoProntoPago,
  valorFijoDescuentoProntoPago: doc.valorFijoDescuentoProntoPago,
  diasGraciaDescuento: doc.diasGraciaDescuento,
  interesMora: doc.interesMora,
  topeInteresMora: doc.topeInteresMora,
  // `fechaLimiteDescuento`/`fechaSuspension` have no schema `default` (only
  // `required: true`, which Mongoose enforces on save, never on read) — a
  // lote created before these two fields existed reads back with them
  // `undefined`, and `.toISOString()` on that would 500 the WHOLE list, not
  // just this one row. Falls back to the same defaults `crear()` computes
  // when the caller omits them, so an old lote still shows something sane.
  fechaLimiteDescuento: (
    doc.fechaLimiteDescuento ?? doc.fechaFacturacion
  ).toISOString(),
  fechaSuspension: (doc.fechaSuspension ?? doc.periodoHasta).toISOString(),
  inmuebleId: doc.inmuebleId ? doc.inmuebleId.toString() : null,
  totalNovedades: doc.novedades.length,
  totalPrevisualizacion: doc.previsualizacion.length,
  resumen: doc.resumen
    ? {
        montoTotal: doc.resumen.montoTotal,
        totalFacturas: doc.resumen.totalFacturas,
        totalInmuebles: doc.resumen.totalInmuebles,
        tipoDocumento: 'FV',
        primerNumero: doc.resumen.primerNumero ?? null,
        ultimoNumero: doc.resumen.ultimoNumero ?? null,
      }
    : null,
  progreso: doc.progreso
    ? { actual: doc.progreso.actual, total: doc.progreso.total }
    : null,
});

const preliminarDe = (p: FacturaPreliminar): FacturaPreliminarContract => ({
  inmuebleId: p.inmuebleId.toString(),
  inmuebleCodigo: p.codigoInmueble,
  terceroId: p.terceroId ? p.terceroId.toString() : null,
  titular: titularDe(p.titular),
  // Nothing has been issued yet — every línea's own total is entirely
  // pending. NOT `p.lineas.map(lineaDe)`: `.map` would silently pass the
  // array INDEX as `lineaDe`'s second (`saldoPendiente`) argument instead.
  lineas: p.lineas.map((linea) => lineaDe(linea, linea.valorTotal)),
  subtotal: p.subtotal,
  totalImpuestos: p.totalImpuestos,
  total: p.total,
});

/**
 * `toLote` plus the full previsualización array — what `findOne()` returns
 * so the Liquidación screen can render its table. `findAll()` keeps using
 * `toLote` — the listing must not embed every lote's full preview array.
 */
export const toLoteDetalle = (
  doc: LoteFacturacionDocument,
): LoteFacturacionDetalle => ({
  ...toLote(doc),
  previsualizacion: doc.previsualizacion.map(preliminarDe),
});
