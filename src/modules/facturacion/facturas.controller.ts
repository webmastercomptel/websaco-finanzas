// src/modules/facturacion/facturas.controller.ts
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { FacturasService } from './facturas.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PlantillaDocumentoService } from '../../common/documentos/plantilla-documento.service';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import { extraerPaginaPdf } from '../../common/documentos/extraer-pagina-pdf.util';
import { toPlantilla } from '../plantillas-documento/plantillas-documento.mapper';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { ListarFacturasDto } from './dto/listar-facturas.dto';
import type {
  DatosPlantillaFactura,
  DocumentoFactura,
  Factura,
  Paginado,
} from '../../contracts';

/**
 * Read-only: invoices are only ever created via a Lote's consolidación
 * (LotesController). There is no create/update/delete here, and there must
 * not be one — a Factura's fields are frozen by design.
 *
 * `POST /facturas/:id/anular` (the `annul` exception "the audit law" always
 * allows) is NOT here — see `AnularFacturaController`
 * (`modules/notas-credito/`) for why it lives in that module instead despite
 * the route path.
 */
@Controller('facturas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class FacturasController {
  constructor(
    private readonly facturas: FacturasService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly plantillas: PlantillaDocumentoService,
    private readonly presentacionDocumento: PresentacionDocumentoService,
    private readonly storage: DocumentoStorageService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findAll(@Query() query: ListarFacturasDto): Promise<Paginado<Factura>> {
    return this.facturas.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  findOne(@Param('id') id: string): Promise<Factura> {
    return this.facturas.findOne(id);
  }

  /**
   * A view of one Factura's PDF content — the current `FV` template plus
   * this invoice's own `datos`. A Factura is batch-only: its lote's invoice
   * run produces ONE combined PDF (one page per invoice, anchored on the
   * Lote's own id — see `LotesController.solicitarGeneracionFacturas`/
   * `:id/url-lectura`). Reading that combined file to show a single invoice
   * would leak every other unit's invoice to whoever is only entitled to see
   * their own, so this route never touches it — same reasoning as
   * `LotesController`'s Prefactura routes.
   *
   * `datos` comes from `factura.printSnapshot` VERBATIM when it is set (the
   * normal case, once the lote's PDF has been generated) — never recomputed,
   * so an old invoice's genuinely mutable fields (`referenciaPago`/
   * `totalAnticipos`/`notas`/`emisor`/`resolucion`) always show what was true
   * when it was actually issued, not today's live values. Falls back to a
   * live `FacturasService.datosPlantilla` computation only when
   * `printSnapshot` is still `null` — an invoice whose lote hasn't had its
   * PDF generated yet. Same `read` action as `findOne` above.
   */
  @Get(':id/documento')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async obtenerDocumento(@Param('id') id: string): Promise<DocumentoFactura> {
    const factura = await this.facturas.findOneRaw(id);

    if (factura.printSnapshot) {
      // Pinned to the version that was actually live when this invoice's
      // lote was generated (`presentacion_documento`'s own
      // `plantillaVersion`, set once at `solicitarGeneracion` time) — never
      // "whatever the template looks like today". Falls back to the
      // CURRENT template only for a row written before this field existed
      // (`plantillaVersion` still `null`), same graceful-degradation the
      // rest of this codebase already uses for pre-feature data.
      const presentacionLote = await this.presentacionDocumento.buscar(
        'FV',
        factura.loteId,
      );
      const plantilla = presentacionLote?.plantillaVersion
        ? await this.plantillas.findVersion(
            'FV',
            presentacionLote.plantillaVersion,
          )
        : await this.plantillas.findOne('FV');
      return {
        plantilla: toPlantilla(plantilla),
        datos: factura.printSnapshot as unknown as DatosPlantillaFactura,
      };
    }

    const plantilla = await this.plantillas.findOne('FV');
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return {
      plantilla: toPlantilla(plantilla),
      datos: await this.facturas.datosPlantilla(factura, copropiedad),
    };
  }

  /**
   * This invoice's own frozen PDF page, extracted server-side from its
   * lote's already-uploaded combined file — the actual fix for the
   * immutability gap `obtenerDocumento` above still has even once
   * `printSnapshot` is frozen: `datos` stops drifting, but the TEMPLATE
   * used to render it was always the live one, so editing `plantilla_
   * documento` today silently changed how every already-issued invoice
   * looked on reopen. Extracting a page out of the combined file sidesteps
   * that entirely — it is literally a slice of the same bytes the lote's
   * own download already serves, so there is nothing left to re-render or
   * drift.
   *
   * 404s (never falls back silently) whenever the page isn't available yet
   * — `printSnapshot`/`paginaEnLote` still `null` (lote not confirmed), or
   * the lote's own `presentacion_documento` row missing/unconfirmed (should
   * be impossible once `paginaEnLote` is set, checked anyway rather than
   * trusted). The frontend (`verDocumentoFactura`) tries this route FIRST
   * and falls back to the live `{ plantilla, datos }` render
   * (`obtenerDocumento`) only on that 404 — same "try the frozen path,
   * fall back to live" shape `generarYSubir`'s 409 handling already uses
   * for the other five document types.
   *
   * Extracted fresh on every call, nothing persisted — viewing one invoice
   * on its own (support cases: a resident's email bounced, a full inbox…)
   * is rare enough that trading a few extra bytes copied per request for
   * zero added Storage is the right side of that trade. Same `read` action
   * as `findOne`/`obtenerDocumento` above.
   */
  @Get(':id/documento-pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async obtenerDocumentoPdf(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const factura = await this.facturas.findOneRaw(id);
    if (!factura.printSnapshot || factura.paginaEnLote === null) {
      throw new NotFoundException(
        `La factura ${id} todavía no tiene una página individual disponible`,
      );
    }

    const presentacionLote = await this.presentacionDocumento.buscar(
      'FV',
      factura.loteId,
    );
    if (!presentacionLote) {
      throw new NotFoundException(
        `La factura ${id} todavía no tiene una página individual disponible`,
      );
    }

    const bytesCombinado = await this.storage.descargarBytes(
      presentacionLote.objectPath,
    );
    const bytesPagina = await extraerPaginaPdf(
      bytesCombinado,
      factura.paginaEnLote,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${id}.pdf"`,
    });
    res.send(Buffer.from(bytesPagina));
  }
}
