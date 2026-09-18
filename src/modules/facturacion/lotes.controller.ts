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
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { paginaPrefactura } from '../../common/pdf/prefactura-pdf';
import { serializarArbol } from '../../common/pdf/react/serializar-arbol';
import { generarPdfConsultaFacturacion } from '../../common/pdf/consulta-facturacion-pdf';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';

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
   * One unit's prefactura, as a react-pdf presentation tree the browser
   * renders — same idea as `Factura.documentDefinition`, but with no moment
   * to freeze it at: a Prefactura previews a not-yet-issued invoice, so this
   * is computed FRESH on every call from the lote's current `preview`,
   * never cached. Route renamed from `.../prefactura.pdf` — no PDF is built
   * here anymore, the browser renders this client-side.
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
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return {
      // `paginaPrefactura` always returns a single element (never the array
      // branch `serializarArbol` also allows for) — same cast pattern
      // `consolidar()` uses when it freezes each Factura's own tree
      // (`lotes.service.ts`, `presentacionDocumento.guardarVarios`).
      documentDefinition: serializarArbol(
        paginaPrefactura(preliminar, lote, copropiedad),
      ) as DocumentoPrefactura['documentDefinition'],
    };
  }

  /**
   * Every unit's prefactura from the lote's CURRENT previsualización, each
   * as its own presentation tree for the browser to render — the
   * Liquidación screen's full-batch preview, reachable before consolidación
   * even exists (unlike `:id/facturas/documentos`, which needs real
   * Facturas). Computed FRESH on every call, one entry per unit — there is
   * no frozen field to read back, unlike `Factura.documentDefinition`: a
   * Prefactura always reflects whatever `preview` holds right now, edits
   * included. Route renamed from `.../prefacturas.pdf` — no PDF is built
   * here anymore.
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
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    return lote.preview.map((preliminar) => ({
      inmuebleId: preliminar.inmuebleId.toString(),
      // Same "always a single element" cast as the single-unit route above.
      documentDefinition: serializarArbol(
        paginaPrefactura(preliminar, lote, copropiedad),
      ) as DocumentoPrefacturaLote['documentDefinition'],
    }));
  }

  /**
   * Every Factura this lote's consolidación produced, as its own frozen
   * `documentDefinition` — one entry per invoice, in the exact layout
   * `GET /facturas/:id` already shows for one at a time (both read the same
   * `presentacion_documento` row, frozen once by
   * `LotesFacturacionService.consolidar()`; see `serializarArbol`). No PDF is
   * built here anymore — the browser renders each entry client-side — so
   * there's nothing left to stream: `.lean()` (`findAllRawPorLote`) already
   * keeps the Factura fetch cheap for a lote with hundreds of invoices, and
   * `buscarVarios` batches the presentation lookup into one query instead of
   * one per invoice.
   *
   * Route renamed from `:id/facturas.pdf` — the old `.pdf` suffix would be
   * actively misleading on a JSON response.
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

    const documentDefinitions = await this.presentacionDocumento.buscarVarios(
      'FV',
      facturas.map((factura) => factura._id),
    );

    return facturas.map((factura) => ({
      id: factura._id.toString(),
      // Opaque blob, passed through unchanged — same cast `toFactura`
      // (`facturas.mapper.ts`) uses for the same field.
      documentDefinition: (documentDefinitions.get(factura._id.toString()) ??
        null) as DocumentoFacturaLote['documentDefinition'],
    }));
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
