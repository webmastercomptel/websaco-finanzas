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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LotesFacturacionService } from './lotes.service';
import { FacturasService } from './facturas.service';
import { ConsultaFacturacionService } from './consulta-facturacion.service';
import { CrearLoteDto } from './dto/crear-lote.dto';
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
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { generarPdfPrefactura } from '../../common/pdf/prefactura-pdf';
import { generarPdfPrefacturaReactPdf } from '../../common/pdf/prefactura-pdf.react';
import { generarPdfPrefacturasLote } from '../../common/pdf/prefacturas-lote-pdf';
import { generarPdfPrefacturasLoteReactPdf } from '../../common/pdf/prefacturas-lote-pdf.react';
import { generarPdfFacturasLote } from '../../common/pdf/facturas-lote-pdf';
import { generarPdfFacturasLoteReactPdf } from '../../common/pdf/facturas-lote-pdf.react';
import { generarPdfConsultaFacturacion } from '../../common/pdf/consulta-facturacion-pdf';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ResolucionFacturacion,
  ResolucionFacturacionDocument,
} from '../../database/schemas/numeracion/resolucion-facturacion.schema';
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
    @InjectModel(ResolucionFacturacion.name)
    private readonly resoluciones: Model<ResolucionFacturacionDocument>,
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
    // TEMPORARY — pdf-lib -> react-pdf migration QA toggle, ?version=new.
    // Remove once react-pdf fully replaces generarPdfPrefactura.
    @Query('version') version: string | undefined,
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

    const bytes =
      version === 'new'
        ? await generarPdfPrefacturaReactPdf(preliminar, lote, copropiedad)
        : await generarPdfPrefactura(preliminar, lote, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="prefactura-${preliminar.unitCode}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  /**
   * Every unit's prefactura from the lote's CURRENT previsualización,
   * bundled into one PDF — the Liquidación screen's full-batch preview,
   * reachable before consolidación even exists (unlike `:id/facturas.pdf`
   * below, which needs real Facturas). Reflects whatever `preview` holds
   * right now, edits included, since it is generated fresh on every call
   * rather than cached.
   */
  @Get(':id/prefacturas.pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async generarPdfPrefacturas(
    @Param('id') id: string,
    // TEMPORARY — pdf-lib -> react-pdf migration QA toggle, ?version=new.
    // Remove once react-pdf fully replaces generarPdfPrefacturasLote.
    @Query('version') version: string | undefined,
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

    const bytes =
      version === 'new'
        ? await generarPdfPrefacturasLoteReactPdf(lote.preview, lote, copropiedad)
        : await generarPdfPrefacturasLote(lote.preview, lote, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="prefacturas-lote-${lote.number}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  /**
   * Every Factura this lote's consolidación produced, bundled into one PDF —
   * one invoice per page, in the exact layout `GET /facturas/:id/pdf`
   * already shows for one at a time. See `generarPdfFacturasLote`.
   */
  @Get(':id/facturas.pdf')
  @CheckAbility({ action: 'read', subject: 'Factura' })
  async generarPdfFacturas(
    @Param('id') id: string,
    // TEMPORARY — pdf-lib -> react-pdf migration QA toggle, ?version=new.
    // Remove once react-pdf fully replaces generarPdfFacturasLote.
    @Query('version') version: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const lote = await this.lotes.findOneRaw(id);

    const facturas = await this.facturas.findAllRawPorLote(id);
    if (facturas.length === 0) {
      throw new NotFoundException(
        `El lote ${id} todavía no tiene facturas emitidas`,
      );
    }

    const idsResolucion = [
      ...new Set(
        facturas
          .map((f) => f.resolucionId?.toString())
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    const resoluciones = idsResolucion.length
      ? await this.resoluciones
          .find({ _id: { $in: idsResolucion }, coPropertyId })
          .exec()
      : [];
    const resolucionesPorId = new Map(
      resoluciones.map((r) => [r._id.toString(), r]),
    );

    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes =
      version === 'new'
        ? await generarPdfFacturasLoteReactPdf(facturas, resolucionesPorId, copropiedad)
        : await generarPdfFacturasLote(facturas, resolucionesPorId, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="facturas-lote-${lote.number}.pdf"`,
    });
    res.send(Buffer.from(bytes));
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
