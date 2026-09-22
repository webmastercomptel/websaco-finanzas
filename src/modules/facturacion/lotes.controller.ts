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
import { Model, Types } from 'mongoose';
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
  ResultadoConfirmacionGeneracionFacturaLote,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfConsultaFacturacion } from '../../common/pdf/consulta-facturacion-pdf';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { PlantillaDocumentoService } from '../../common/documentos/plantilla-documento.service';
import { toPlantilla } from '../plantillas-documento/plantillas-documento.mapper';
import { ConfirmarGeneracionFacturaLoteDto } from './dto/confirmar-generacion-factura-lote.dto';
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
    private readonly plantillas: PlantillaDocumentoService,
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
   * Every Factura this lote's consolidación produced, with its own
   * presentation pointer — one entry per invoice, in the exact layout
   * `GET /facturas/:id` already shows for one at a time (both read the same
   * `presentacion_documento` row). `.lean()` (`findAllRawPorLote`) keeps the
   * Factura fetch cheap for a lote with hundreds of invoices, and
   * `buscarVarios` batches the presentation lookup into one query instead of
   * one per invoice.
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

    const presentaciones = await this.presentacionDocumento.buscarVarios(
      'FV',
      facturas.map((factura) => factura._id),
    );

    return facturas.map((factura) => {
      const presentacion = presentaciones.get(factura._id.toString());
      return {
        id: factura._id.toString(),
        inmuebleCodigo: factura.unitCode,
        objectPath: presentacion?.objectPath ?? null,
        generatedAt: presentacion?.generatedAt.toISOString() ?? null,
      };
    });
  }

  /**
   * Batch `solicitar-generacion` for every Factura this lote produced — the
   * template for `FV` is fetched ONCE (never once per invoice), and each
   * invoice gets its own upload target (`objectPath`/`uploadUrl`) plus its
   * own computed `datos` (`FacturasService.datosPlantilla`). Same guard as
   * `:id/consolidar` — provisioning invoices in bulk is the same capability
   * as issuing one.
   */
  @Post(':id/facturas/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  async solicitarGeneracionFacturas(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionFacturaLote> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    await this.lotes.findOneRaw(id);

    const facturasLean = await this.facturas.findAllRawPorLote(id);
    if (facturasLean.length === 0) {
      throw new NotFoundException(
        `El lote ${id} todavía no tiene facturas emitidas`,
      );
    }

    const [copropiedad, plantilla, datosVisualesPorInmueble] =
      await Promise.all([
        this.copropiedades.findById(coPropertyId).exec(),
        this.plantillas.findOne('FV'),
        this.facturas.datosVisualesPdf(facturasLean.map((f) => f.inmuebleId)),
      ]);
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const facturas = await Promise.all(
      facturasLean.map(async (factura) => {
        const { objectPath, uploadUrl, expiresAt } =
          await this.presentacionDocumento.solicitarGeneracion(
            'FV',
            factura._id,
            coPropertyId,
          );
        const datos = await this.facturas.datosPlantilla(
          factura,
          copropiedad,
          datosVisualesPorInmueble.get(factura.inmuebleId.toString()),
        );
        return {
          facturaId: factura._id.toString(),
          objectPath,
          uploadUrl,
          expiresAt: expiresAt.toISOString(),
          datos,
        };
      }),
    );

    return { plantilla: toPlantilla(plantilla), facturas };
  }

  /**
   * Batch `confirmar-generacion` — one confirmation per Factura the
   * frontend already uploaded a rendered PDF for. Best-effort per row, same
   * "one bad row never blocks the rest" shape as `consolidar()`'s own
   * `errores` array: one invoice's upload failing to verify must never
   * block confirming the others.
   */
  @Post(':id/facturas/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'Factura' })
  async confirmarGeneracionFacturas(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionFacturaLoteDto,
  ): Promise<ResultadoConfirmacionGeneracionFacturaLote> {
    await this.lotes.findOneRaw(id);

    const confirmadas: string[] = [];
    const errores: ResultadoConfirmacionGeneracionFacturaLote['errores'] = [];

    for (const item of dto.facturas) {
      try {
        await this.presentacionDocumento.confirmarGeneracion(
          'FV',
          new Types.ObjectId(item.facturaId),
          item.objectPath,
        );
        confirmadas.push(item.facturaId);
      } catch (err) {
        errores.push({
          facturaId: item.facturaId,
          mensaje: err instanceof Error ? err.message : 'Error desconocido',
        });
      }
    }

    return { confirmadas, errores };
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
