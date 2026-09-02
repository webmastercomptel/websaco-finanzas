import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';
import { VencimientosCarteraService } from './vencimientos-cartera.service';
import { CarteraGeneralService } from './cartera-general.service';
import { EstadoCuentaService } from './estado-cuenta.service';
import { ListarAuxiliarCarteraDto } from './dto/listar-auxiliar-cartera.dto';
import { ConsultarVencimientosCarteraDto } from './dto/consultar-vencimientos-cartera.dto';
import { ConsultarCarteraGeneralDto } from './dto/consultar-cartera-general.dto';
import { ConsultarPeriodosEstadoCuentaDto } from './dto/consultar-periodos-estado-cuenta.dto';
import { ConsultarEstadoCuentaDto } from './dto/consultar-estado-cuenta.dto';
import type {
  RespuestaAuxiliarCartera,
  RespuestaVencimientosCartera,
  RespuestaCarteraGeneral,
  PeriodoFacturado,
  RespuestaEstadoCuenta,
} from '../../contracts';

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
    private readonly estadoCuenta: EstadoCuentaService,
  ) {}

  @Get('auxiliar-cartera')
  @CheckAbility({ action: 'read', subject: 'Consulta' })
  findAll(
    @Query() query: ListarAuxiliarCarteraDto,
  ): Promise<RespuestaAuxiliarCartera> {
    return this.auxiliarCartera.findAll(query);
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
}
