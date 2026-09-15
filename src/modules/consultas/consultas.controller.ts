import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { Response } from 'express';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';
import { VencimientosCarteraService } from './vencimientos-cartera.service';
import { CarteraGeneralService } from './cartera-general.service';
import { CarteraPorInmuebleService } from './cartera-por-inmueble.service';
import { CarteraPorConceptosService } from './cartera-por-conceptos.service';
import { EstadoCuentaService } from './estado-cuenta.service';
import { MovimientoContableService } from './movimiento-contable.service';
import { ConciliacionCarteraService } from './conciliacion-cartera.service';
import { ConsecutivosService } from './consecutivos.service';
import { ListarAuxiliarCarteraDto } from './dto/listar-auxiliar-cartera.dto';
import { ConsultarVencimientosCarteraDto } from './dto/consultar-vencimientos-cartera.dto';
import { ConsultarVencimientosCarteraPdfDto } from './dto/consultar-vencimientos-cartera-pdf.dto';
import { ConsultarCarteraGeneralDto } from './dto/consultar-cartera-general.dto';
import { ConsultarCarteraPorInmuebleDto } from './dto/consultar-cartera-por-inmueble.dto';
import { ConsultarCarteraPorConceptosDto } from './dto/consultar-cartera-por-conceptos.dto';
import { ConsultarCarteraPorConceptosPdfDto } from './dto/consultar-cartera-por-conceptos-pdf.dto';
import { ConsultarPeriodosEstadoCuentaDto } from './dto/consultar-periodos-estado-cuenta.dto';
import { ConsultarEstadoCuentaDto } from './dto/consultar-estado-cuenta.dto';
import { ConsultarMovimientoContableDto } from './dto/consultar-movimiento-contable.dto';
import { ConsultarMovimientoContablePdfDto } from './dto/consultar-movimiento-contable-pdf.dto';
import { ConsultarConciliacionCarteraDto } from './dto/consultar-conciliacion-cartera.dto';
import { ConsultarConsecutivosDto } from './dto/consultar-consecutivos.dto';
import type {
  RespuestaAuxiliarCartera,
  RespuestaVencimientosCartera,
  RespuestaCarteraGeneral,
  RespuestaCarteraPorInmueble,
  RespuestaCarteraPorConceptos,
  PeriodoFacturado,
  RespuestaEstadoCuenta,
  RespuestaMovimientoContable,
  RespuestaConciliacionCartera,
  RespuestaConsecutivos,
} from '../../contracts';
import { generarPdfEstadoCuenta } from '../../common/pdf/estado-cuenta-pdf';
import { generarPdfAuxiliarCartera } from '../../common/pdf/auxiliar-cartera-pdf';
import { generarPdfConciliacionCartera } from '../../common/pdf/conciliacion-cartera-pdf';
import { generarPdfCarteraGeneral } from '../../common/pdf/cartera-general-pdf';
import { generarPdfCarteraPorInmueble } from '../../common/pdf/cartera-por-inmueble-pdf';
import { generarPdfCarteraPorConceptos } from '../../common/pdf/cartera-por-conceptos-pdf';
import { generarPdfVencimientosCartera } from '../../common/pdf/vencimientos-cartera-pdf';
import { generarPdfMovimientoContable } from '../../common/pdf/movimiento-contable-pdf';
import { generarPdfConsecutivos } from '../../common/pdf/consecutivos-pdf';

/**
 * Read-only reporting endpoint. Reuses the already-stubbed 'Consulta'
 * CASL subject — action `read` only.
 */
@Controller('consultas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class ConsultasController {
  constructor(
    private readonly auxiliarCartera: AuxiliarCarteraService,
    private readonly vencimientosCartera: VencimientosCarteraService,
    private readonly carteraGeneral: CarteraGeneralService,
    private readonly carteraPorInmueble: CarteraPorInmuebleService,
    private readonly carteraPorConceptos: CarteraPorConceptosService,
    private readonly estadoCuenta: EstadoCuentaService,
    private readonly movimientoContable: MovimientoContableService,
    private readonly conciliacionCartera: ConciliacionCarteraService,
    private readonly consecutivos: ConsecutivosService,
    private readonly tenant: TenantContextService,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
  ) {}

  @Get('auxiliar-cartera')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findAll(
    @Query() query: ListarAuxiliarCarteraDto,
  ): Promise<RespuestaAuxiliarCartera> {
    return this.auxiliarCartera.findAll(query);
  }

  @Get('auxiliar-cartera/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfAuxiliarCartera(
    @Query() query: ListarAuxiliarCarteraDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.auxiliarCartera.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfAuxiliarCartera(reporte, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="auxiliar-cartera-${reporte.inmuebleCodigo}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Get('vencimientos-cartera')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findVencimientos(
    @Query() query: ConsultarVencimientosCarteraDto,
  ): Promise<RespuestaVencimientosCartera> {
    return this.vencimientosCartera.findAll(query);
  }

  @Get('vencimientos-cartera/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfVencimientosCartera(
    @Query() query: ConsultarVencimientosCarteraPdfDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.vencimientosCartera.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfVencimientosCartera(reporte, copropiedad, {
      inmuebleId: query.inmuebleId,
      rango: query.rango,
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="vencimientos-cartera-${reporte.fechaCorte.slice(0, 10)}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Get('cartera-general')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findCarteraGeneral(
    @Query() query: ConsultarCarteraGeneralDto,
  ): Promise<RespuestaCarteraGeneral> {
    return this.carteraGeneral.findAll(query);
  }

  @Get('cartera-general/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfCarteraGeneral(
    @Query() query: ConsultarCarteraGeneralDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.carteraGeneral.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const fechaCorte = query.fecha ?? new Date().toISOString();
    const bytes = await generarPdfCarteraGeneral(
      reporte,
      copropiedad,
      fechaCorte,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cartera-general-${fechaCorte.slice(0, 10)}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Get('cartera-por-inmueble')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findCarteraPorInmueble(
    @Query() query: ConsultarCarteraPorInmuebleDto,
  ): Promise<RespuestaCarteraPorInmueble> {
    return this.carteraPorInmueble.findOne(query);
  }

  @Get('cartera-por-inmueble/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfCarteraPorInmueble(
    @Query() query: ConsultarCarteraPorInmuebleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.carteraPorInmueble.findOne(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfCarteraPorInmueble(reporte, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cartera-${reporte.inmuebleCodigo}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Get('cartera-por-conceptos')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findCarteraPorConceptos(
    @Query() query: ConsultarCarteraPorConceptosDto,
  ): Promise<RespuestaCarteraPorConceptos> {
    return this.carteraPorConceptos.findAll(query);
  }

  @Get('cartera-por-conceptos/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfCarteraPorConceptos(
    @Query() query: ConsultarCarteraPorConceptosPdfDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.carteraPorConceptos.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const fechaCorte = query.fecha ?? new Date().toISOString();
    const bytes = await generarPdfCarteraPorConceptos(
      reporte,
      copropiedad,
      fechaCorte,
      query.tipo,
      query.conceptoId,
    );

    const sufijoConcepto = query.conceptoId ? '-concepto' : '';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cartera-por-conceptos-${query.tipo}${sufijoConcepto}-${fechaCorte.slice(0, 10)}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  @Get('estado-cuenta/periodos')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findPeriodosEstadoCuenta(
    @Query() query: ConsultarPeriodosEstadoCuentaDto,
  ): Promise<PeriodoFacturado[]> {
    return this.estadoCuenta.findPeriodos(query.inmuebleId);
  }

  @Get('estado-cuenta')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findEstadoCuenta(
    @Query() query: ConsultarEstadoCuentaDto,
  ): Promise<RespuestaEstadoCuenta> {
    return this.estadoCuenta.findAll(query);
  }

  @Get('estado-cuenta/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfEstadoCuenta(
    @Query() query: ConsultarEstadoCuentaDto,
    @Query('duplicado') duplicado: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const estado = await this.estadoCuenta.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfEstadoCuenta(estado, copropiedad, {
      duplicado: duplicado === 'true',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="estado-cuenta-${estado.inmuebleCodigo}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  /* ── Conciliación de Cartera ────────────────────────────────────── */

  /** Coproperty-wide, unlike Estado de Cuenta's own periodos — no
   *  `inmuebleId` to filter by. */
  @Get('conciliacion-cartera/periodos')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findPeriodosConciliacionCartera(): Promise<PeriodoFacturado[]> {
    return this.conciliacionCartera.findPeriodos();
  }

  @Get('conciliacion-cartera')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findConciliacionCartera(
    @Query() query: ConsultarConciliacionCarteraDto,
  ): Promise<RespuestaConciliacionCartera> {
    return this.conciliacionCartera.findAll(query);
  }

  @Get('conciliacion-cartera/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfConciliacionCartera(
    @Query() query: ConsultarConciliacionCarteraDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.conciliacionCartera.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfConciliacionCartera(reporte, copropiedad);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="conciliacion-cartera-${reporte.periodStart.slice(0, 10)}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  /* ── Consulta de Movimiento Contable ───────────────────────────── */

  /** Coproperty-wide accounting journal for a date range. */
  @Get('movimiento-contable')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findMovimientoContable(
    @Query() query: ConsultarMovimientoContableDto,
  ): Promise<RespuestaMovimientoContable> {
    return this.movimientoContable.findAll(query);
  }

  @Get('movimiento-contable/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfMovimientoContable(
    @Query() query: ConsultarMovimientoContablePdfDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.movimientoContable.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfMovimientoContable(
      reporte,
      copropiedad,
      query.desde,
      query.hasta,
      {
        tipo: query.tipo,
        inmuebleCodigo: query.inmuebleCodigo,
        numero: query.numero,
      },
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="movimiento-contable-${query.desde}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }

  /* ── Consecutivos ───────────────────────────────────────────────── */

  @Get('consecutivos')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findConsecutivos(
    @Query() query: ConsultarConsecutivosDto,
  ): Promise<RespuestaConsecutivos> {
    return this.consecutivos.findAll(query);
  }

  @Get('consecutivos/pdf')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  async generarPdfConsecutivos(
    @Query() query: ConsultarConsecutivosDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    const reporte = await this.consecutivos.findAll(query);
    const copropiedad = await this.copropiedades.findById(coPropertyId).exec();
    if (!copropiedad) {
      throw new NotFoundException(
        `No se encontró la copropiedad ${coPropertyId.toString()}`,
      );
    }

    const bytes = await generarPdfConsecutivos(
      reporte,
      copropiedad,
      query.codigo,
      query.desde,
      query.hasta,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="consecutivos-${query.codigo}-${query.desde}.pdf"`,
    });
    res.send(Buffer.from(bytes));
  }
}
