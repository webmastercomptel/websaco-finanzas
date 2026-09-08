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
import { EstadoCuentaService } from './estado-cuenta.service';
import { MovimientoContableService } from './movimiento-contable.service';
import { ListarAuxiliarCarteraDto } from './dto/listar-auxiliar-cartera.dto';
import { ConsultarVencimientosCarteraDto } from './dto/consultar-vencimientos-cartera.dto';
import { ConsultarCarteraGeneralDto } from './dto/consultar-cartera-general.dto';
import { ConsultarCarteraPorInmuebleDto } from './dto/consultar-cartera-por-inmueble.dto';
import { ConsultarPeriodosEstadoCuentaDto } from './dto/consultar-periodos-estado-cuenta.dto';
import { ConsultarEstadoCuentaDto } from './dto/consultar-estado-cuenta.dto';
import { ConsultarMovimientoContableDto } from './dto/consultar-movimiento-contable.dto';
import type {
  RespuestaAuxiliarCartera,
  RespuestaVencimientosCartera,
  RespuestaCarteraGeneral,
  RespuestaCarteraPorInmueble,
  PeriodoFacturado,
  RespuestaEstadoCuenta,
  RespuestaMovimientoContable,
} from '../../contracts';
import { generarPdfEstadoCuenta } from '../../common/pdf/estado-cuenta-pdf';
import { generarPdfAuxiliarCartera } from '../../common/pdf/auxiliar-cartera-pdf';

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
    private readonly estadoCuenta: EstadoCuentaService,
    private readonly movimientoContable: MovimientoContableService,
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

  @Get('cartera-general')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findCarteraGeneral(
    @Query() query: ConsultarCarteraGeneralDto,
  ): Promise<RespuestaCarteraGeneral> {
    return this.carteraGeneral.findAll(query);
  }

  @Get('cartera-por-inmueble')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findCarteraPorInmueble(
    @Query() query: ConsultarCarteraPorInmuebleDto,
  ): Promise<RespuestaCarteraPorInmueble> {
    return this.carteraPorInmueble.findOne(query);
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

  /* ── Consulta de Movimiento Contable ───────────────────────────── */

  /** Coproperty-wide accounting journal for a date range. */
  @Get('movimiento-contable')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findMovimientoContable(
    @Query() query: ConsultarMovimientoContableDto,
  ): Promise<RespuestaMovimientoContable> {
    return this.movimientoContable.findAll(query);
  }
}
