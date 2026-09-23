import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ConsecutivoDocumento,
  ConsecutivoDocumentoDocument,
} from '../../database/schemas/numeracion/consecutivo-documento.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';

/** One of the five non-Factura document types' own `code` on
 *  `ConsecutivoDocumento` — see that schema's own docblock (`code` is the
 *  client-facing type, distinct from the fixed `category`). `'NA'` has no
 *  row of its own in practice today (confirmed against the real "Tabla de
 *  Documentos" admin screen) — `resolverGenerico` simply falls through to
 *  its default in that case, nothing special-cased. */
export type CodigoDocumentoGenerico = 'RC' | 'NC' | 'ND' | 'NT' | 'NA';

/** Defaults matching EXACTLY today's hardcoded literal in each
 *  `*-pdf-datos.util.ts` — used until a coproperty renames the type under
 *  Configuración → Documentos ("Tabla de Documentos"). */
const TITULOS_POR_DEFECTO: Record<CodigoDocumentoGenerico, string> = {
  RC: 'Recibo de Caja',
  NC: 'Nota de Crédito',
  ND: 'Nota de Débito',
  NT: 'Nota Contable',
  NA: 'Nota de Anticipo',
};

/** Fallback title for a Factura when neither the frozen resolución nor the
 *  `'FV'` `ConsecutivoDocumento` row carries a `displayName` — matches the
 *  Factura PDF template's own long-standing default. */
const TITULO_FACTURA_POR_DEFECTO = 'Cobro Expensas Comunes';

/** A Factura's own frozen DIAN resolution, resolved into the shape its
 *  pdfmake template prints — see `DatosPlantillaFactura.resolucion`
 *  (contracts/index.ts). `prefijo` here is always the CALLER-SUPPLIED
 *  invoice prefix, never the resolución's own `prefix` — see
 *  `TituloDocumentoService.resolverFactura`'s own docblock for why. */
export interface ResolucionPlantillaFactura {
  numero: string;
  nombreVisible: string | null;
  prefijo: string;
  rangoDesde: number;
  rangoHasta: number;
  vigenteDesde: string;
  vigenteHasta: string | null;
}

/**
 * Resolves the printed document title from "Tabla de Documentos"
 * (`ConsecutivoDocumento.displayName`) — currently DEAD DATA: a coproperty
 * admin can rename "Recibo de Caja" there today and nothing on the printed
 * PDF changes, because no `*-pdf-datos.util.ts` ever read it (each hardcodes
 * its own Spanish literal). This service is what wires that configuration
 * screen to the actual printed document, for Factura and its five siblings.
 *
 * Registered on the (global) `CommonModule`, same reasoning as
 * `PlantillaDocumentoService`/`GeneracionDocumentoService` — every one of the
 * six document modules needs this at `datosImpresion`/`datosPlantilla` time,
 * not just `facturación`.
 */
@Injectable()
export class TituloDocumentoService {
  constructor(
    @InjectModel(ConsecutivoDocumento.name)
    private readonly consecutivos: Model<ConsecutivoDocumentoDocument>,
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
  ) {}

  /** The title for one of the five non-Factura document types. */
  async resolverGenerico(
    tipoDocumento: CodigoDocumentoGenerico,
    coPropertyId: Types.ObjectId,
  ): Promise<string> {
    const fila = await this.consecutivos
      .findOne({ coPropertyId, code: tipoDocumento })
      .exec();
    return fila?.displayName ?? TITULOS_POR_DEFECTO[tipoDocumento];
  }

  /**
   * The title AND the frozen DIAN resolution for an already-issued Factura.
   *
   * CRITICAL correctness point: when `resolucionId` is set, this fetches
   * THAT SPECIFIC `ResolucionFacturacion` by id — never "whichever one is
   * active right now". A Factura's own `resolucionId` is already frozen at
   * issuance; substituting the currently active resolution here would print
   * the WRONG resolution on an old invoice once the coproperty switches —
   * exactly the immutability gap this whole task exists to close.
   *
   * `facturaPrefix` is the invoice's OWN frozen `prefix` field — the
   * returned `resolucion.prefijo` is always built from this, never from
   * `resolucion.prefix` itself (a resolución's prefix can be edited in
   * "Tabla de Documentos" after issuance; the invoice's own printed prefix
   * must never move).
   */
  async resolverFactura(
    coPropertyId: Types.ObjectId,
    resolucionId: Types.ObjectId | null,
    facturaPrefix: string,
  ): Promise<{
    titulo: string;
    resolucion: ResolucionPlantillaFactura | null;
  }> {
    if (resolucionId) {
      const resolucion = await this.resoluciones.findById(resolucionId).exec();
      if (resolucion) {
        const tituloPorDefecto =
          await this.tituloFacturaPorDefecto(coPropertyId);
        return {
          titulo: resolucion.displayName ?? tituloPorDefecto,
          resolucion: {
            numero: resolucion.resolutionNumber,
            nombreVisible: resolucion.displayName,
            prefijo: facturaPrefix,
            rangoDesde: resolucion.rangeFrom,
            rangoHasta: resolucion.rangeTo,
            vigenteDesde: resolucion.validFrom.toISOString(),
            vigenteHasta: resolucion.validUntil
              ? resolucion.validUntil.toISOString()
              : null,
          },
        };
      }
    }
    return {
      titulo: await this.tituloFacturaPorDefecto(coPropertyId),
      resolucion: null,
    };
  }

  /** `ConsecutivoDocumento('FV')`'s own `displayName`, falling back to the
   *  Factura PDF's long-standing default — the fallback both branches of
   *  `resolverFactura` share. Not `resolverGenerico`: `'FV'` is never one of
   *  its five codes (a Factura's title comes from its resolución first, a
   *  plain consecutivo second — never treated as "just another generic
   *  document type"). */
  private async tituloFacturaPorDefecto(
    coPropertyId: Types.ObjectId,
  ): Promise<string> {
    const fila = await this.consecutivos
      .findOne({ coPropertyId, code: 'FV' })
      .exec();
    return fila?.displayName ?? TITULO_FACTURA_POR_DEFECTO;
  }
}
