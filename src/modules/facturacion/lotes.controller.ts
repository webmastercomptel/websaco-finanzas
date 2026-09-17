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
import { pipeline } from 'node:stream/promises';
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
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfPrefactura } from '../../common/pdf/prefactura-pdf';
import { generarPdfPrefacturasLote } from '../../common/pdf/prefacturas-lote-pdf';
import { generarPdfConsultaFacturacion } from '../../common/pdf/consulta-facturacion-pdf';
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

  @Get(':id/inmuebles/:inmuebleId/prefactura.pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async generarPrefacturaPdf(
    @Param('id') id: string,
    @Param('inmuebleId') inmuebleId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
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

    const bytes = await generarPdfPrefactura(preliminar, lote, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="prefactura-${preliminar.unitCode}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  /**
   * Every unit's prefactura from the lote's CURRENT previsualización,
   * bundled into one PDF — the Liquidación screen's full-batch preview,
   * reachable before consolidación even exists (unlike
   * `:id/facturas/documentos` below, which needs real Facturas). Reflects
   * whatever `preview` holds
   * right now, edits included, since it is generated fresh on every call
   * rather than cached.
   */
  @Get(':id/prefacturas.pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async generarPdfPrefacturas(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
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

    const stream = await generarPdfPrefacturasLote(
      lote.preview,
      lote,
      copropiedad,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="prefacturas-lote-${lote.number}.pdf"`,
    });
    // Piped, not buffered — `generarPdfPrefacturasLote` streams the render so
    // an N-unit batch never sits fully in memory before it reaches the client.
    // `pipeline` (not raw `.pipe`) so a client disconnect mid-download destroys
    // the render stream too, instead of leaving the request hung forever.
    await pipeline(stream, res);
  }

  /**
   * Every Factura this lote's consolidación produced, as its own frozen
   * `documentDefinition` — one entry per invoice, in the exact layout
   * `GET /facturas/:id/pdf` already shows for one at a time (both read the
   * same field, frozen once by `LotesFacturacionService.consolidar()`; see
   * `serializarArbol`). No PDF is built here anymore — the browser renders
   * each entry client-side — so there's nothing left to stream: `.lean()`
   * (`findAllRawPorLote`) already keeps this cheap for a lote with hundreds
   * of invoices, the way `.lean()` + streaming used to for the PDF version.
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

    return facturas.map((factura) => ({
      id: factura._id.toString(),
      // Opaque blob, passed through unchanged — same cast `toFactura`
      // (`facturas.mapper.ts`) uses for the same field.
      documentDefinition: (factura.documentDefinition ??
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
