import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Factura,
  FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  SaldoTotalDocumento,
  SaldoTotalDocumentoDocument,
} from '../../database/schemas/facturacion/saldo-total-documento.schema';
import {
  CarteraPorDocumento,
  CarteraPorDocumentoDocument,
} from '../../database/schemas/facturacion/cartera-por-documento.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  Recibo,
  ReciboDocument,
} from '../../database/schemas/recibos/recibo.schema';
import {
  SaldoDocumentoOrigen,
  SaldoDocumentoOrigenDocument,
} from '../../database/schemas/recibos/saldo-documento-origen.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { TituloDocumentoService } from '../../common/documentos/titulo-documento.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type {
  Factura as FacturaContract,
  DatosPlantillaFactura,
  EmisorPlantillaFactura,
  ResolucionPlantillaFactura,
  TitularFactura,
  Paginado,
  FilaMarcadorFactura,
  ReferenciaPagoFilaFactura,
  IvaFilaFactura,
  AnticiposFilaFactura,
  NotasFilaFactura,
  DescuentoFilaFactura,
  ResolucionFilaFactura,
} from '../../contracts';
import { toFactura, titularDe } from './facturas.mapper';
import type { ListarFacturasDto } from './dto/listar-facturas.dto';
import { calcularDescuentoProntoPago } from '../../common/facturacion/descuento-pronto-pago.util';
import { emisorDe } from '../../common/documentos/emisor.util';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { FacturaLinea } from '../../database/schemas/facturacion/factura-linea.schema';

export type { FacturaDocument };

@Injectable()
export class FacturasService {
  constructor(
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(SaldoTotalDocumento.name)
    private readonly saldoTotalDocumento: Model<SaldoTotalDocumentoDocument>,
    @InjectModel(CarteraPorDocumento.name)
    private readonly carteraPorDocumento: Model<CarteraPorDocumentoDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Recibo.name)
    private readonly recibos: Model<ReciboDocument>,
    @InjectModel(SaldoDocumentoOrigen.name)
    private readonly saldoDocumentoOrigen: Model<SaldoDocumentoOrigenDocument>,
    private readonly tenant: TenantContextService,
    // APPENDED LAST, optional — same convention every sibling document
    // service already uses for a dependency only some methods need (see
    // e.g. `RecibosService`'s own `terceros?`/`presentacionDocumento?`): so
    // the many existing hand-rolled-mock tests that stop their positional
    // argument list before this one keep compiling. Backs `datosPlantilla`'s
    // own `resolverFactura` call; real requests always get it from Nest's DI.
    private readonly tituloDocumento?: TituloDocumentoService,
  ) {}

  /** Batch-resolves each document's own live per-concepto breakdown from
   *  `CarteraPorDocumento` — needed by `toFactura`'s per-línea
   *  `saldoPendiente`, no longer a field the document itself carries. */
  private async carteraPorConceptoDe(
    documentoIds: FacturaDocument['_id'][],
  ): Promise<Map<string, Map<string, number>>> {
    const filas = documentoIds.length
      ? await this.carteraPorDocumento
          .find({ documentoId: { $in: documentoIds } })
          .exec()
      : [];
    const porDocumento = new Map<string, Map<string, number>>();
    for (const fila of filas) {
      const docKey = fila.documentoId.toString();
      const porConcepto = porDocumento.get(docKey) ?? new Map<string, number>();
      porConcepto.set(fila.conceptoId.toString(), fila.saldoPendiente);
      porDocumento.set(docKey, porConcepto);
    }
    return porDocumento;
  }

  async findAll(query: ListarFacturasDto): Promise<Paginado<FacturaContract>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { coPropertyId };
    if (query.inmuebleId) filtro.inmuebleId = query.inmuebleId;
    if (query.buscar) {
      // Escaped: a search box is user input, and an unescaped regex lets a
      // stray "(" throw, or a crafted one pin the database at 100%.
      filtro.fullNumber = { $regex: escapeRegex(query.buscar), $options: 'i' };
    }
    if (query.estado) {
      filtro.status = query.estado;
    } else if (query.conSaldoPendiente) {
      filtro.status = 'emitida';
    }
    if (query.conSaldoPendiente) {
      // No longer a field on Factura itself — resolve candidate ids from
      // `SaldoTotalDocumento` first (see that schema's own docblock), same
      // pattern `NotasDebitoService.findAll` already uses.
      const conSaldo = await this.saldoTotalDocumento
        .find({ coPropertyId, tipoDocumento: 'FV', saldoPendiente: { $gt: 0 } })
        .exec();
      filtro._id = { $in: conSaldo.map((s) => s.documentoId) };
    }
    if (query.fechaDesde || query.fechaHasta) {
      filtro.issueDate = {
        ...(query.fechaDesde ? { $gte: new Date(query.fechaDesde) } : {}),
        ...(query.fechaHasta ? { $lte: new Date(query.fechaHasta) } : {}),
      };
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [documentos, total] = await Promise.all([
      this.facturas
        .find(filtro)
        .sort({ issueDate: -1, _id: -1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.facturas.countDocuments(filtro).exec(),
    ]);

    const ids = documentos.map((d) => d._id);
    const [saldos, carteraPorDoc] = await Promise.all([
      ids.length
        ? this.saldoTotalDocumento.find({ documentoId: { $in: ids } }).exec()
        : Promise.resolve([]),
      this.carteraPorConceptoDe(ids),
    ]);
    const saldoPorDocumento = new Map(
      saldos.map((s) => [s.documentoId.toString(), s.saldoPendiente]),
    );

    return {
      items: documentos.map((doc) =>
        toFactura(
          doc,
          saldoPorDocumento.get(doc._id.toString()) ?? 0,
          carteraPorDoc.get(doc._id.toString()) ?? new Map<string, number>(),
        ),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  async findOne(id: string): Promise<FacturaContract> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.facturas
      .findOne({ _id: id, coPropertyId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la factura ${id}`);
    }
    const [saldoTotal, carteraPorDoc] = await Promise.all([
      this.saldoTotalDocumento.findOne({ documentoId: documento._id }).exec(),
      this.carteraPorConceptoDe([documento._id]),
    ]);
    return toFactura(
      documento,
      saldoTotal?.saldoPendiente ?? 0,
      carteraPorDoc.get(documento._id.toString()) ?? new Map<string, number>(),
    );
  }

  /**
   * One Factura, raw and lean, scoped to the active tenant — used by
   * `FacturasController.obtenerDocumento` to compute a live
   * `DatosPlantillaFactura` for a single invoice without hydrating a full
   * Mongoose document, same reasoning as `findAllRawPorLote` (this method's
   * batch counterpart). Structurally the same shape `datosPlantilla` already
   * accepts (`FacturaLean`).
   */
  async findOneRaw(id: string): Promise<FacturaLean> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const documento = await this.facturas
      .findOne({ _id: id, coPropertyId })
      .lean()
      .exec();
    if (!documento) {
      throw new NotFoundException(`No se encontró la factura ${id}`);
    }
    return documento;
  }

  /**
   * Every Factura one lote's consolidación produced, raw — used by
   * `LotesController.obtenerDocumentosFacturas`/`solicitarGeneracionFacturas`
   * to work the whole batch without hydrating every invoice (the mapped
   * contract is built separately, from the real documents, by `findOne`).
   * Ordered by unit code, the same order the roster and the Liquidación
   * table already use, so a batch reads in a predictable sequence.
   *
   * `.lean()` on purpose: a lote can carry hundreds of Facturas, and this
   * only ever needs plain fields (see `FacturaLean` below, also what
   * `datosPlantilla` accepts) — hydrating full Mongoose documents here is
   * pure overhead this batch endpoint can't afford under Cloud Run's memory
   * ceiling.
   */
  async findAllRawPorLote(loteId: string) {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.facturas
      .find({ coPropertyId, loteId })
      .sort({ unitCode: 1 })
      .lean()
      .exec();
  }

  /**
   * Purely cosmetic data the Factura/Prefactura PDF prints alongside the
   * document's own frozen fields — never persisted on the document itself,
   * always read live: `referencia` off the current `Inmueble` row (per
   * product decision, this is a live cross-reference, not a billing fact
   * worth freezing the way `unitCode`/`holder` are), and `totalAnticipos`
   * from that unit's own currently pending Recibo balances.
   *
   * `totalAnticipos` reuses the exact "anticipos pendientes" definition
   * `EstadoCuentaService` already established: the sum of `saldoDisponible`
   * (`SaldoDocumentoOrigen`, `tipoDocumento: 'RC'`) across this unit's
   * `activo` Recibos — never Notas de Anticipo or Saldos Iniciales de
   * Anticipo, which that same precedent excludes too.
   */
  async datosVisualesPdf(
    inmuebleIds: Types.ObjectId[],
  ): Promise<Map<string, DatosVisualesFactura>> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const ids = [...new Set(inmuebleIds.map((id) => id.toString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const resultado = new Map<string, DatosVisualesFactura>();
    if (ids.length === 0) return resultado;

    const [inmuebles, recibosActivos] = await Promise.all([
      this.inmuebles.find({ _id: { $in: ids }, coPropertyId }).exec(),
      this.recibos
        .find({ coPropertyId, inmuebleId: { $in: ids }, status: 'activo' })
        .exec(),
    ]);

    const saldos = recibosActivos.length
      ? await this.saldoDocumentoOrigen
          .find({
            coPropertyId,
            tipoDocumento: 'RC',
            documentoId: { $in: recibosActivos.map((r) => r._id) },
          })
          .exec()
      : [];
    const saldoPorRecibo = new Map(
      saldos.map((s) => [s.documentoId.toString(), s.saldoDisponible]),
    );

    const anticipoPorInmueble = new Map<string, number>();
    for (const recibo of recibosActivos) {
      const monto = saldoPorRecibo.get(recibo._id.toString()) ?? 0;
      if (monto <= 0) continue;
      const key = recibo.inmuebleId.toString();
      anticipoPorInmueble.set(key, (anticipoPorInmueble.get(key) ?? 0) + monto);
    }

    for (const inmueble of inmuebles) {
      const key = inmueble._id.toString();
      resultado.set(key, {
        referencia: inmueble.reference,
        totalAnticipos: anticipoPorInmueble.get(key) ?? 0,
        usage: inmueble.usage,
      });
    }
    return resultado;
  }

  /**
   * The "Cargos del Mes / Saldo Anterior / Nuevo Saldo" table and its totals
   * — relocated verbatim from the old react-pdf
   * `contenidoDocumentoFacturacion` (`common/pdf/factura-pdf.ts:94-137`) now
   * that rendering moved to the frontend (pdfmake). Shared by `datosPlantilla`
   * (an issued Factura) and `datosPlantillaPreliminar` (a not-yet-issued
   * Prefactura), same split as the old `paginaFactura`/`paginaPrefactura`
   * both building a `DatosDocumentoFacturacion` before handing it to this
   * shared body.
   */
  private construirDatosPlantilla(
    lines: FacturaLinea[],
    descuento: { monto: number; fechaLimite: Date } | null,
    totalAnticipos: number,
    referenciaPago: string | null,
    notas: string | null,
    tituloDocumento: string,
    emisor: EmisorPlantillaFactura,
    resolucion: ResolucionPlantillaFactura | null,
    titular: TitularFactura | null,
    uso: string | null,
  ): DatosPlantillaFactura {
    const totalSaldoAnterior = lines.reduce(
      (acc, l) => acc + l.balanceBefore,
      0,
    );
    const totalCargosDelMes = lines.reduce((acc, l) => acc + l.baseAmount, 0);
    const totalNuevoSaldo = totalSaldoAnterior + totalCargosDelMes;
    const totalIva = lines.reduce((acc, l) => acc + l.taxAmount, 0);
    const totalAPagar = lines.reduce((acc, l) => acc + l.balanceAfter, 0);

    const cargos = lines.map((l) => ({
      nombre:
        l.taxAmount > 0 ? `${l.conceptName} (${l.taxRate}%)` : l.conceptName,
      saldoAnterior: l.balanceBefore,
      cargosDelMes: l.baseAmount,
      nuevoSaldo: l.balanceBefore + l.baseAmount,
    }));

    const tasasIva = new Set(
      lines.filter((l) => l.taxAmount > 0).map((l) => l.taxRate),
    );
    const etiquetaIva =
      tasasIva.size === 1 ? `IVA ${[...tasasIva][0]}%` : 'IVA';

    const totalConDescuento = descuento
      ? totalAPagar - descuento.monto - totalAnticipos
      : null;

    const logoFilas: FilaMarcadorFactura[] = emisor.mostrarLogo ? [{}] : [];
    const referenciaPagoFilas: ReferenciaPagoFilaFactura[] = referenciaPago
      ? [{ referenciaPago }]
      : [];
    const ivaFilas: IvaFilaFactura[] =
      totalIva > 0 ? [{ etiquetaIva, totalIva }] : [];
    const anticiposFilas: AnticiposFilaFactura[] =
      totalAnticipos > 0 ? [{ totalAnticipos }] : [];
    const notasFilas: NotasFilaFactura[] = notas ? [{ notas }] : [];
    const descuentoFilas: DescuentoFilaFactura[] =
      totalConDescuento !== null && descuento
        ? [
            {
              fechaLimiteDescuento: descuento.fechaLimite.toISOString(),
              totalConDescuento,
            },
          ]
        : [];
    const resolucionFilas: ResolucionFilaFactura[] = resolucion
      ? [{ textoResolucion: this.textoResolucion(resolucion) }]
      : [];

    const titularEmailMostrado = titular?.email ?? '—';
    const titularTelefonoMostrado = titular?.telefono ?? '—';
    const titularIdentificacionMostrada = titular
      ? [titular.tipoIdentificacion, titular.numeroIdentificacion]
          .filter(Boolean)
          .join(' ') || '—'
      : '—';

    return {
      cargos,
      totalSaldoAnterior,
      totalCargosDelMes,
      totalNuevoSaldo,
      totalIva,
      etiquetaIva,
      uso,
      totalAPagar,
      totalConDescuento,
      referenciaPago,
      totalAnticipos,
      notas,
      tituloDocumento,
      emisor,
      resolucion,
      tieneDescuentoProntoPago: totalConDescuento !== null,
      titular,
      titularEmailMostrado,
      titularTelefonoMostrado,
      titularIdentificacionMostrada,
      totalAPagarFinal: totalAPagar - totalAnticipos,
      logoFilas,
      referenciaPagoFilas,
      ivaFilas,
      anticiposFilas,
      notasFilas,
      descuentoFilas,
      resolucionFilas,
    };
  }

  /** The whole DIAN-resolution footer sentence, pre-composed — see
   *  `ResolucionFilaFactura`'s own docblock for why this can't be built
   *  inside the template itself (the " vigente hasta …" tail is
   *  conditional, and the pdfmake template has no conditional primitive).
   *  Relocated verbatim from the old react-pdf `paginaFactura`'s own
   *  `pie` text. */
  private textoResolucion(resolucion: ResolucionPlantillaFactura): string {
    const vigenteHasta = resolucion.vigenteHasta
      ? ` vigente hasta ${resolucion.vigenteHasta}`
      : '';
    return (
      `Resolución de Facturación DIAN No. ${resolucion.numero} ` +
      `del ${resolucion.vigenteDesde}. ` +
      `Numeración autorizada de ${resolucion.prefijo}${resolucion.rangoDesde} ` +
      `a ${resolucion.prefijo}${resolucion.rangoHasta}${vigenteHasta}`
    );
  }

  /**
   * `DatosPlantillaFactura` for one already-issued Factura — what
   * `LotesController`'s batch `solicitar-generacion` route sends alongside
   * each invoice's upload target. `datosVisuales` is optional: the batch
   * caller resolves it once for the whole lote (`datosVisualesPdf`) and
   * passes each invoice's own entry in to avoid one extra round trip per
   * invoice; omitted, this resolves it itself for standalone callers.
   *
   * Accepts `FacturaLean` (not `FacturaDocument`) for the same reason
   * `paginaFactura` did — a real hydrated document is structurally
   * assignable to the plain-fields lean shape, so the batch route (which
   * only ever has `.lean()`-fetched invoices, see `findAllRawPorLote`) can
   * pass either without a cast.
   */
  async datosPlantilla(
    factura: FacturaLean,
    copropiedad: CopropiedadDocument,
    datosVisuales?: DatosVisualesFactura,
  ): Promise<DatosPlantillaFactura> {
    const visuales =
      datosVisuales ??
      (await this.datosVisualesPdf([factura.inmuebleId])).get(
        factura.inmuebleId.toString(),
      );
    const descuento =
      factura.discountAmount > 0 && factura.discountDeadline
        ? {
            monto: factura.discountAmount,
            fechaLimite: factura.discountDeadline,
          }
        : null;
    // Non-null: always injected in the real app, same trailing-optional
    // convention as every sibling document service (see the constructor's
    // own comment) — left optional only for existing positional-mock tests
    // that never exercise this path.
    const { titulo, resolucion } = await this.tituloDocumento!.resolverFactura(
      factura.coPropertyId,
      factura.resolucionId,
      factura.prefix,
    );
    return this.construirDatosPlantilla(
      factura.lines,
      descuento,
      visuales?.totalAnticipos ?? 0,
      visuales?.referencia ?? null,
      copropiedad.billingNotes?.trim() || null,
      titulo,
      emisorDe(copropiedad),
      resolucion,
      titularDe(factura.holder),
      visuales?.usage ?? null,
    );
  }

  /** Freezes `datos` onto this invoice's own `printSnapshot` — called once,
   *  right after its lote's combined PDF is confirmed uploaded (see
   *  `LotesController.confirmarGeneracionFacturas`). See
   *  `Factura.printSnapshot`'s own docblock for the immutability gap this
   *  closes. */
  async guardarPrintSnapshot(
    facturaId: Types.ObjectId,
    datos: DatosPlantillaFactura,
  ): Promise<void> {
    await this.facturas
      .updateOne({ _id: facturaId }, { $set: { printSnapshot: datos } })
      .exec();
  }

  /**
   * `DatosPlantillaFactura` for a not-yet-issued Prefactura — computed fresh
   * on every call, same as the rest of a Prefactura's response, since it has
   * no issuance moment to freeze at. The discount is recomputed from the
   * lote's own parameters (`calcularDescuentoProntoPago`), unlike an issued
   * Factura's already-frozen `discountAmount`/`discountDeadline`.
   */
  datosPlantillaPreliminar(
    preliminar: FacturaPreliminar,
    lote: LoteFacturacionDocument,
    copropiedad: CopropiedadDocument,
    datosVisuales?: DatosVisualesFactura,
  ): DatosPlantillaFactura {
    const { discountAmount, discountDeadline } = calcularDescuentoProntoPago(
      preliminar.lines,
      lote.earlyPaymentDiscount,
      lote.earlyPaymentDiscountFixedValue,
      lote.discountDeadline,
      copropiedad.discountAppliesWithLateFee,
    );
    const descuento =
      discountAmount > 0 && discountDeadline
        ? { monto: discountAmount, fechaLimite: discountDeadline }
        : null;
    return this.construirDatosPlantilla(
      preliminar.lines,
      descuento,
      datosVisuales?.totalAnticipos ?? 0,
      datosVisuales?.referencia ?? null,
      copropiedad.billingNotes?.trim() || null,
      // Never resolved via TituloDocumentoService: a Prefactura is a
      // preview, not a real document type — it has no row of its own under
      // "Tabla de Documentos", literally "Prefactura" always.
      'Prefactura',
      emisorDe(copropiedad),
      // No frozen resolución to show yet — a Prefactura is unnumbered, so
      // there is nothing to resolve (see this method's own docblock).
      null,
      titularDe(preliminar.holder),
      datosVisuales?.usage ?? null,
    );
  }
}

/**
 * Plain-object shape `.lean()` resolves for a Factura — every field a
 * consumer of `findAllRawPorLote` can rely on, without the full Mongoose
 * document's methods/getters. Derived from the method's own inferred return
 * type rather than a hand-rolled `LeanDocument<...>` (removed in Mongoose
 * 6+) — see `findAllRawPorLote` above.
 */
export type FacturaLean = Awaited<
  ReturnType<FacturasService['findAllRawPorLote']>
>[number];

/** Cosmetic, live-read data the PDF prints alongside a Factura/Prefactura's
 *  own frozen fields — see `FacturasService.datosVisualesPdf`, the only
 *  place that computes it. Relocated from the now-deleted
 *  `common/pdf/factura-pdf.ts` react-pdf renderer (pdfmake + frontend-render
 *  migration); kept local to this file since `FacturasService` is its only
 *  consumer, unlike `DatosReciboImpresion`'s cross-module sharing. */
export interface DatosVisualesFactura {
  referencia: string | null;
  totalAnticipos: number;
  usage: string | null;
}
