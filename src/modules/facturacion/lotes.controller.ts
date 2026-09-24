// src/modules/facturacion/lotes.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LotesFacturacionService } from './lotes.service';
import { FacturasService } from './facturas.service';
import { ConsultaFacturacionService } from './consulta-facturacion.service';
import { CrearLoteDto } from './dto/crear-lote.dto';
import { CrearFacturaIndividualDto } from './dto/crear-factura-individual.dto';
import { ActualizarLoteDto } from './dto/actualizar-lote.dto';
import { CargarNovedadesDto } from './dto/cargar-novedades.dto';
import {
  AgregarNovedadLineaDto,
  EditarNovedadLineaDto,
} from './dto/novedad-linea.dto';
import type {
  ErrorConsolidacion,
  LoteFacturacion,
  LoteFacturacionDetalle,
  ResultadoCargaNovedades,
  RespuestaConsultaFacturacion,
  DocumentoFacturaLote,
  DocumentoPrefactura,
  DocumentoPrefacturaLote,
  SolicitudGeneracionFacturaLote,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfConsultaFacturacion } from '../../common/pdf/consulta-facturacion-pdf';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { PlantillaDocumentoService } from '../../common/documentos/plantilla-documento.service';
import { toPlantilla } from '../plantillas-documento/plantillas-documento.mapper';
import { GeneracionDocumentoService } from '../../common/documentos/generacion-documento.service';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import { PDFDocument } from 'pdf-lib';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  LOTE_FACTURAS_PDF_CONFIRMADO,
  type LoteFacturasPdfConfirmadoEvent,
} from '../../common/eventos/lote-facturas-pdf-confirmado.event';

/**
 * The monthly billing cycle: define a run, upload novedades, liquidar
 * (preview), consolidar (commit). `subject: 'Factura'` throughout — there is
 * no separate CASL subject for a Lote; provisioning invoices in bulk is the
 * same capability as issuing one.
 */
@Controller('lotes')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class LotesController {
  constructor(
    private readonly lotes: LotesFacturacionService,
    private readonly facturas: FacturasService,
    private readonly consultaFacturacion: ConsultaFacturacionService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly presentacionDocumento: PresentacionDocumentoService,
    private readonly plantillas: PlantillaDocumentoService,
    private readonly generacion: GeneracionDocumentoService,
    private readonly eventos: EventEmitter2,
    private readonly storage: DocumentoStorageService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findAll(): Promise<LoteFacturacion[]> {
    return this.lotes.findAll();
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findOne(@Param('id') id: string): Promise<LoteFacturacionDetalle> {
    return this.lotes.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Factura' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearLoteDto,
  ): Promise<LoteFacturacion> {
    // PoliciesGuard already required a Factura/create permission, which only
    // an account with an active assignment can hold — accountId is
    // guaranteed set here, unlike on the account-less-allowed /auth/me route.
    return this.lotes.crear(user.accountId!, dto);
  }

  /**
   * Starts a "Factura Individual" — a one-off Lote scoped to one inmueble,
   * pinned to the current period. Every other route below (add/edit cargo,
   * liquidar, consolidar, cancelar, the PDFs) already works on it unchanged
   * — see `LotesFacturacionService.crearIndividual`.
   */
  @Post('individual')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  crearIndividual(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearFacturaIndividualDto,
  ): Promise<LoteFacturacion> {
    return this.lotes.crearIndividual(user.accountId!, dto);
  }

  /**
   * Edits the run's own definition — reachable up to consolidación, exactly
   * what lets a coproperty admin fix a wrong date or a stale Parámetros
   * snapshot without cancelling the whole run. See
   * `LotesFacturacionService.actualizar` for why this always resets the
   * lote to `borrador` (its `preview`, if any, no longer matches).
   */
  @Patch(':id/definicion')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  actualizarDefinicion(
    @Param('id') id: string,
    @Body() dto: ActualizarLoteDto,
  ): Promise<LoteFacturacion> {
    return this.lotes.actualizar(id, dto);
  }

  @Post(':id/novedades')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  cargarNovedades(
    @Param('id') id: string,
    @Body() dto: CargarNovedadesDto,
  ): Promise<ResultadoCargaNovedades> {
    return this.lotes.cargarNovedades(id, dto.filas);
  }

  @Post(':id/liquidar')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  liquidar(@Param('id') id: string): Promise<LoteFacturacion> {
    return this.lotes.liquidar(id);
  }

  @Post(':id/novedades/lineas')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  agregarNovedadLinea(
    @Param('id') id: string,
    @Body() dto: AgregarNovedadLineaDto,
  ): Promise<LoteFacturacion> {
    return this.lotes.agregarNovedadLinea(id, dto);
  }

  @Patch(':id/novedades/:novedadId')
  @CheckAbility({ action: 'update', subject: 'Factura' })
  editarNovedadLinea(
    @Param('id') id: string,
    @Param('novedadId') novedadId: string,
    @Body() dto: EditarNovedadLineaDto,
  ): Promise<LoteFacturacion> {
    return this.lotes.editarNovedadLinea(id, novedadId, dto);
  }

  /**
   * One unit's prefactura — the current template for `FV` plus this unit's
   * computed totals, both computed/read FRESH on every call from the lote's
   * current `preview`, never cached: a Prefactura previews a not-yet-issued
   * invoice, so it has no moment to freeze at and no `presentacion_documento`
   * row of its own. The browser renders it client-side (pdfmake) from these
   * two pieces.
   */
  @Get(':id/inmuebles/:inmuebleId/prefactura/documento')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async obtenerDocumentoPrefactura(
    @Param('id') id: string,
    @Param('inmuebleId') inmuebleId: string,
  ): Promise<DocumentoPrefactura> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOneRaw(id);
    const preliminar = lote.preview.find(
      (p) => p.inmuebleId.toString() === inmuebleId,
    );
    if (!preliminar) {
      throw new NotFoundException(
        `El lote ${id} no tiene una previsualización para el inmueble ${inmuebleId}`,
      );
    }
    const [copropiedad, datosVisualesPorInmueble, plantilla] =
      await Promise.all([
        this.copropiedades.findById(coPropertyId).exec(),
        this.facturas.datosVisualesPdf([preliminar.inmuebleId]),
        this.plantillas.findOne('FV'),
      ]);
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return {
      plantilla: toPlantilla(plantilla),
      datos: this.facturas.datosPlantillaPreliminar(
        preliminar,
        lote,
        copropiedad,
        datosVisualesPorInmueble.get(preliminar.inmuebleId.toString()),
      ),
    };
  }

  /**
   * Every unit's prefactura from the lote's CURRENT previsualización — the
   * Liquidación screen's full-batch preview, reachable before consolidación
   * even exists (unlike `:id/facturas/documentos`, which needs real
   * Facturas). The template is fetched ONCE for the whole batch, not once
   * per unit — same reasoning as the Factura batch `solicitar-generacion`
   * route below. Computed FRESH on every call: a Prefactura always reflects
   * whatever `preview` holds right now, edits included, never cached.
   */
  @Get(':id/prefacturas/documentos')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async obtenerDocumentosPrefacturas(
    @Param('id') id: string,
  ): Promise<DocumentoPrefacturaLote[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOneRaw(id);
    if (lote.preview.length === 0) {
      throw new NotFoundException(
        `El lote ${id} todavía no tiene una previsualización generada`,
      );
    }
    const [copropiedad, datosVisualesPorInmueble] = await Promise.all([
      this.copropiedades.findById(coPropertyId).exec(),
      this.facturas.datosVisualesPdf(lote.preview.map((p) => p.inmuebleId)),
    ]);
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return lote.preview.map((preliminar) => ({
      inmuebleId: preliminar.inmuebleId.toString(),
      inmuebleCodigo: preliminar.unitCode,
      datos: this.facturas.datosPlantillaPreliminar(
        preliminar,
        lote,
        copropiedad,
        datosVisualesPorInmueble.get(preliminar.inmuebleId.toString()),
      ),
    }));
  }

  /**
   * A plain listing of every Factura this lote's consolidación produced —
   * id and unit code only. There is no per-invoice presentation pointer any
   * more: a lote's invoice run produces ONE combined PDF, anchored on the
   * Lote's own id (see `:id/url-lectura` below), not on any one Factura's.
   * `.lean()` (`findAllRawPorLote`) keeps the Factura fetch cheap for a lote
   * with hundreds of invoices.
   */
  @Get(':id/facturas/documentos')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async obtenerDocumentosFacturas(
    @Param('id') id: string,
  ): Promise<DocumentoFacturaLote[]> {
    // Confirms the lote exists (and belongs to this tenant) before reporting
    // "no facturas emitidas" instead of a plain empty array either way.
    await this.lotes.findOneRaw(id);

    const facturas = await this.facturas.findAllRawPorLote(id);
    if (facturas.length === 0) {
      throw new NotFoundException(
        `El lote ${id} todavía no tiene facturas emitidas`,
      );
    }

    return facturas.map((factura) => ({
      id: factura._id.toString(),
      inmuebleCodigo: factura.unitCode,
    }));
  }

  /**
   * `solicitar-generacion` for the lote's invoice run — ONE combined PDF
   * (one page per invoice), anchored on the LOTE's own id via the shared
   * `GeneracionDocumentoService.solicitar` (same helper every other document
   * type already uses), not on any one Factura's. The template for `FV` is
   * fetched ONCE, and each invoice's own computed `datos`
   * (`FacturasService.datosPlantilla`) travels as the array the frontend
   * renders one page per entry from — no per-invoice upload target any
   * more. Same guard as `:id/consolidar` — provisioning invoices in bulk is
   * the same capability as issuing one.
   */
  @Post(':id/facturas/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  async solicitarGeneracionFacturas(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionFacturaLote> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOneRaw(id);

    const facturasLean = await this.facturas.findAllRawPorLote(id);
    if (facturasLean.length === 0) {
      throw new NotFoundException(
        `El lote ${id} todavía no tiene facturas emitidas`,
      );
    }

    const [copropiedad, datosVisualesPorInmueble] = await Promise.all([
      this.copropiedades.findById(coPropertyId).exec(),
      this.facturas.datosVisualesPdf(facturasLean.map((f) => f.inmuebleId)),
    ]);
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const facturas = await Promise.all(
      facturasLean.map(async (factura) => ({
        facturaId: factura._id.toString(),
        datos: await this.facturas.datosPlantilla(
          factura,
          copropiedad,
          datosVisualesPorInmueble.get(factura.inmuebleId.toString()),
        ),
      })),
    );

    const { plantilla, objectPath, uploadUrl, expiresAt } =
      await this.generacion.solicitar('FV', lote, facturas);

    return { plantilla, objectPath, uploadUrl, expiresAt, facturas };
  }

  /**
   * Confirms the frontend finished uploading the lote's combined PDF
   * `solicitar-generacion` handed it a signed URL for — a single
   * confirmation, the same shared `ConfirmarGeneracionDocumentoDto`/
   * `GeneracionDocumentoService.confirmar` every other document type already
   * uses. There is nothing "best-effort per row" about confirming one file
   * any more — see `SolicitudGeneracionFacturaLote`.
   *
   * Right after confirming, freezes each invoice's own `datos` onto its
   * `printSnapshot` (see that field's own docblock,
   * `factura.schema.ts`) — the actual fix for `datosPlantilla`'s live-read
   * immutability gap. Recomputed here rather than stashed from
   * `solicitarGeneracionFacturas`: confirm only ever runs once, right after
   * a successful upload, so recomputing `datos` fresh costs nothing extra
   * and needs no intermediate state threaded between the two calls (a
   * request/response pair that can be minutes apart, with nothing durable in
   * between to stash into). A failure resolving the copropiedad or building
   * a snapshot never rolls back the confirmation itself — the PDF is already
   * safely uploaded and confirmed either way; only the immutability
   * safeguard would be missing for this run; the next generation still
   * writes it.
   */
  @Post(':id/facturas/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  async confirmarGeneracionFacturas(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOneRaw(id);
    const resultado = await this.generacion.confirmar(
      'FV',
      lote,
      dto.objectPath,
    );

    const facturasLean = await this.facturas.findAllRawPorLote(id);

    // Emitted here, before the snapshot block below, so a snapshot failure
    // can never suppress it — see LOTE_FACTURAS_PDF_CONFIRMADO's own
    // docblock. Awaited: the outbox row must exist before this request
    // returns 200, with no crash window in between. The listener swallows
    // every error itself, so publishing can never fail this confirmation.
    await this.eventos.emitAsync(LOTE_FACTURAS_PDF_CONFIRMADO, {
      coPropertyId: coPropertyId.toString(),
      loteId: lote._id.toString(),
      objectPath: resultado.objectPath,
      numerosFactura: facturasLean.map((f) => f.fullNumber),
    } satisfies LoteFacturasPdfConfirmadoEvent);

    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (facturasLean.length > 0 && copropiedad) {
      const datosVisualesPorInmueble = await this.facturas.datosVisualesPdf(
        facturasLean.map((f) => f.inmuebleId),
      );
      // `indice + 1` is only a SAFE page number when every invoice actually
      // rendered to exactly one page — pdfmake auto-flows content, so a
      // unit with an unusually long charge table can overflow onto a
      // second page, which would silently shift every LATER invoice's real
      // page off by however many extra pages got inserted before it (wrong
      // content extracted, not even an error). Verified here, once, rather
      // than trusted: download the just-uploaded combined PDF and check its
      // real page count against the invoice count. Only when they match is
      // `paginaEnLote` trustworthy for every invoice in this lote — `null`
      // for all of them otherwise, which routes every one of them through
      // the safe live-render fallback (`FacturasController.obtenerDocumento`,
      // now itself pinned to this lote's own `plantillaVersion` — see that
      // route's own docblock) instead of ever risking the fast path.
      const bytesCombinado = await this.storage.descargarBytes(
        resultado.objectPath,
      );
      const paginasReales = (
        await PDFDocument.load(bytesCombinado)
      ).getPageCount();
      const paginacionConfiable = paginasReales === facturasLean.length;

      await Promise.all(
        facturasLean.map(async (factura, indice) => {
          const datos = await this.facturas.datosPlantilla(
            factura,
            copropiedad,
            datosVisualesPorInmueble.get(factura.inmuebleId.toString()),
          );
          await this.facturas.guardarPrintSnapshot(
            factura._id,
            datos,
            paginacionConfiable ? indice + 1 : null,
          );
        }),
      );
    }

    return resultado;
  }

  /**
   * A short-lived signed URL to read back this lote's combined invoice-run
   * PDF (one file, one page per invoice) — never a single Factura's own
   * document, since a Factura no longer has one of its own (see
   * `FacturasController`'s `:id/documento`, computed live instead
   * precisely to avoid leaking every other unit's invoice). Same `read`
   * action as `findOne` above.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const lote = await this.lotes.findOneRaw(id);
    const presentacion = await this.presentacionDocumento.buscar(
      'FV',
      lote._id,
    );
    return this.generacion.urlLectura(
      'El lote de facturación',
      id,
      presentacion ?? { objectPath: null, generatedAt: null },
    );
  }

  /**
   * The results of a consolidado lote: per-concept totals and a per-invoice
   * detail table, derived live from its Facturas. See
   * ConsultaFacturacionService for why this is a focused query rather than
   * a reuse of `findAllRawPorLote`.
   */
  @Get(':id/consulta-facturacion')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  obtenerConsultaFacturacion(
    @Param('id') id: string,
  ): Promise<RespuestaConsultaFacturacion> {
    return this.consultaFacturacion.generar(id);
  }

  @Get(':id/consulta-facturacion.pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async consultaFacturacionPdf(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.consultaFacturacion.generar(id);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfConsultaFacturacion(reporte, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="consulta-facturacion-lote-${reporte.loteNumero}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Post(':id/consolidar')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  consolidar(
    @Param('id') id: string,
  ): Promise<{ lote: LoteFacturacion; errores: ErrorConsolidacion[] }> {
    return this.lotes.consolidar(id);
  }

  /**
   * Hard delete — refused once consolidado, when it would mean discarding
   * real Facturas. See `LotesFacturacionService.cancelar`.
   */
  @Delete(':id')
  @HttpCode(204)
  @CheckAbility({ action: 'manage', subject: 'Factura' })
  cancelar(@Param('id') id: string): Promise<void> {
    return this.lotes.cancelar(id);
  }
}
