// src/modules/interfaz-comptable/payload-comptable.ts
import { Types } from 'mongoose';
import type { AsientoContableDocument } from '../../database/schemas/facturacion/asiento-contable.schema';
import type { Tercero } from '../../database/schemas/terceros/tercero.schema';
import type {
  AsientoPayloadComptable,
  MovimientoPayloadComptable,
  PayloadComptable,
  TerceroPayloadComptable,
} from '../../contracts';
import {
  detalleDeAsiento,
  tipoDocumentoDe,
  type AnchorInfo,
} from '../adicion-contabilidad/resolucion-documentos.service';
import {
  documentoCruceDeMovimiento,
  type DocumentoCruceSaldoInicial,
} from '../saldos-iniciales/saldo-inicial-cruce.util';
import { resolveAnchorId } from '../consultas/movimiento-contable.util';

/** What `ResolucionDocumentosService` resolved for the batch. */
export interface ResolucionPayload {
  anchorMap: Map<string, AnchorInfo>;
  conceptoMap: Map<string, string>;
  saldosInicialesPorNumero: Map<number, DocumentoCruceSaldoInicial>;
}

/** The fields of an inmueble's titular the payload sends. */
export type TitularComptable = Pick<
  Tercero,
  | 'tipoPersona'
  | 'nombre'
  | 'primerNombre'
  | 'segundoNombre'
  | 'primerApellido'
  | 'segundoApellido'
  | 'razonSocial'
  | 'tipoIdentificacion'
  | 'digitoVerificacion'
  | 'emails'
  | 'telefono'
  | 'direccion'
  | 'ciudad'
>;

/** Inmueble code → its titular, or `null` when it has none (or the code
 *  matches no inmueble). */
export type TitularesPorInmueble = Map<string, TitularComptable | null>;

/** The `origen` block, from the lote being sent. */
export interface OrigenPayload {
  copropiedadId: Types.ObjectId | string;
  /** Null only for the preview of a selection no lote holds yet. */
  loteOrigenId: Types.ObjectId | string | null;
  numeroLote: number;
  periodoDesde: Date;
  periodoHasta: Date;
  generadoPor: { accountId: string; nombre: string };
}

/** Amounts travel as integer cents inside this module, so a sum never picks
 *  up binary rounding. */
export const aCentavos = (monto: number): number => Math.round(monto * 100);

/** "350000.00" — decimal point, no thousands separator, always two
 *  decimals; built from integer cents, never `toFixed` on a float sum. */
export const centavosATexto = (centavos: number): string => {
  const signo = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  return `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** Business dates are stored as UTC midnight — local getters would read the
 *  day before west of Greenwich. */
const fechaIso = (fecha: Date): string => fecha.toISOString().slice(0, 10);

const textoONull = (valor: string | null | undefined): string | null =>
  typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null;

/**
 * The tercero of one line: identified by the inmueble code (what the CSV
 * export already uses as tercero), described by that inmueble's titular so
 * Comptable can create it when missing. Without a titular only the code
 * travels — `inmueblesSinTitular` blocks such a lote before it is sent, so
 * this only ever shows up in the preview.
 *
 * Key order is the contract's (the shared fixture is compared as a string).
 */
const terceroDe = (
  codigo: string,
  titular: TitularComptable | null | undefined,
): TerceroPayloadComptable => {
  if (!titular) {
    return {
      identificacion: codigo,
      tipoPersona: null,
      nombre1: null,
      nombre2: null,
      apellido1: null,
      apellido2: null,
      razonSocial: null,
      tipoIdentificacion: null,
      digitoVerificacion: null,
      email: null,
      telefono: null,
      direccion: null,
      ciudad: null,
    };
  }
  const juridica = titular.tipoPersona === 'juridica';
  const nombre1 = textoONull(titular.primerNombre);
  const apellido1 = textoONull(titular.primerApellido);
  return {
    identificacion: codigo,
    tipoPersona: titular.tipoPersona,
    // A natural person registered before the split name fields existed has
    // only `nombre`: send it as the first name rather than nothing, so
    // Comptable can still create the tercero.
    nombre1:
      !juridica && !nombre1 && !apellido1
        ? textoONull(titular.nombre)
        : nombre1,
    nombre2: textoONull(titular.segundoNombre),
    apellido1,
    apellido2: textoONull(titular.segundoApellido),
    // Same fallback for a company with no razón social on file.
    razonSocial: juridica
      ? (textoONull(titular.razonSocial) ?? textoONull(titular.nombre))
      : textoONull(titular.razonSocial),
    tipoIdentificacion: textoONull(titular.tipoIdentificacion),
    digitoVerificacion: textoONull(titular.digitoVerificacion),
    email: textoONull(titular.emails?.[0]),
    telefono: textoONull(titular.telefono),
    direccion: textoONull(titular.direccion),
    ciudad: textoONull(titular.ciudad),
  };
};

/**
 * Builds contract v1 (canonical copy: Comptable's integration design spec)
 * from a batch of asientos. Pure: everything it needs was resolved before,
 * with the same `ResolucionDocumentosService` the CSV export uses, so both
 * channels name a document identically:
 *
 * - `documento` = `tipoDocumentoDe`; `prefijo`/`numero` = the anchor
 *   document's own fields, sent separately (never the CSV's glued key).
 * - `descripcion` and every line's `detalle` = `detalleDeAsiento` (MOVMES's
 *   detalle and MOVMESDO's, which are the same text).
 * - Amounts: strings with two decimals from integer cents; the side a line
 *   does not use is `"0"`.
 * - `centroUtilidad` = `centroCosto`, `centroDestino` always null.
 * - `tipoDocCruce` = the stored cross type (`FV | ND | SI`); `numeroDocCruce`
 *   = for a Saldo Inicial the ORIGINAL document number (as the CSV exports
 *   it), otherwise the stored number, as a string.
 *
 * Key order matches the shared fixture, so `JSON.stringify` of the result is
 * byte-comparable with Comptable's copy.
 */
export function construirPayloadComptable(
  asientos: AsientoContableDocument[],
  resolucion: ResolucionPayload,
  titulares: TitularesPorInmueble,
  origen: OrigenPayload,
): PayloadComptable {
  return {
    version: 1,
    origen: {
      sistema: 'websaco-finanzas',
      copropiedadId: origen.copropiedadId.toString(),
      loteOrigenId: origen.loteOrigenId?.toString() ?? null,
      numeroLote: origen.numeroLote,
      periodoDesde: fechaIso(origen.periodoDesde),
      periodoHasta: fechaIso(origen.periodoHasta),
      generadoPor: {
        accountId: origen.generadoPor.accountId,
        nombre: origen.generadoPor.nombre,
      },
    },
    asientos: asientos.map((asiento) =>
      asientoDe(asiento, resolucion, titulares),
    ),
  };
}

function asientoDe(
  asiento: AsientoContableDocument,
  resolucion: ResolucionPayload,
  titulares: TitularesPorInmueble,
): AsientoPayloadComptable {
  const anchor = resolucion.anchorMap.get(resolveAnchorId(asiento).toString());
  const detalle = detalleDeAsiento(asiento, resolucion.conceptoMap);

  const movimientos = asiento.movimientos.map(
    (mov): MovimientoPayloadComptable => {
      const monto = centavosATexto(aCentavos(mov.monto));
      const cruce = documentoCruceDeMovimiento(
        mov,
        resolucion.saldosInicialesPorNumero,
      );
      const codigoTercero = textoONull(mov.tercero);
      return {
        cuenta: mov.cuenta,
        debito: mov.tipo === 'debito' ? monto : '0',
        credito: mov.tipo === 'credito' ? monto : '0',
        detalle,
        tercero: codigoTercero
          ? terceroDe(codigoTercero, titulares.get(codigoTercero))
          : null,
        centroUtilidad: textoONull(mov.centroCosto),
        centroDestino: null,
        flujoCaja: textoONull(mov.flujoCaja),
        baseGravable:
          mov.baseGravable == null
            ? null
            : centavosATexto(aCentavos(mov.baseGravable)),
        tipoDocCruce: cruce ? (mov.tipoDocumento ?? null) : null,
        numeroDocCruce: cruce ? String(cruce.numero) : null,
      };
    },
  );

  return {
    documento: tipoDocumentoDe(asiento),
    prefijo: anchor?.prefix ?? '',
    numero: anchor?.number ?? 0,
    fecha: fechaIso(asiento.fecha),
    descripcion: detalle,
    movimientos,
  };
}

/**
 * Inmueble codes used as tercero by these asientos whose inmueble has no
 * titular (or does not exist): Comptable cannot create such a tercero, so
 * they block the send and are listed in the preview. Sorted, unique.
 */
export function inmueblesSinTitular(
  asientos: Pick<AsientoContableDocument, 'movimientos'>[],
  titulares: TitularesPorInmueble,
): string[] {
  const sinTitular = new Set<string>();
  for (const codigo of codigosTercero(asientos)) {
    if (!titulares.get(codigo)) sinTitular.add(codigo);
  }
  return [...sinTitular].sort((a, b) => a.localeCompare(b, 'es'));
}

/** Every distinct inmueble code used as tercero by these asientos. */
export function codigosTercero(
  asientos: Pick<AsientoContableDocument, 'movimientos'>[],
): string[] {
  const codigos = new Set<string>();
  for (const asiento of asientos) {
    for (const mov of asiento.movimientos) {
      const codigo = textoONull(mov.tercero);
      if (codigo) codigos.add(codigo);
    }
  }
  return [...codigos];
}

/** Lote totals, summed in cents. */
export interface TotalesPayload {
  totalAsientos: number;
  totalLineas: number;
  totalDebitosCentavos: number;
  totalCreditosCentavos: number;
}

export function totalesDe(
  asientos: Pick<AsientoContableDocument, 'movimientos'>[],
): TotalesPayload {
  let totalLineas = 0;
  let totalDebitosCentavos = 0;
  let totalCreditosCentavos = 0;
  for (const asiento of asientos) {
    for (const mov of asiento.movimientos) {
      totalLineas += 1;
      if (mov.tipo === 'debito') totalDebitosCentavos += aCentavos(mov.monto);
      else totalCreditosCentavos += aCentavos(mov.monto);
    }
  }
  return {
    totalAsientos: asientos.length,
    totalLineas,
    totalDebitosCentavos,
    totalCreditosCentavos,
  };
}
