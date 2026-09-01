import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';
import { VencimientosCarteraService } from './vencimientos-cartera.service';
import { ListarAuxiliarCarteraDto } from './dto/listar-auxiliar-cartera.dto';
import { ConsultarVencimientosCarteraDto } from './dto/consultar-vencimientos-cartera.dto';
import type {
  RespuestaAuxiliarCartera,
  RespuestaVencimientosCartera,
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
}
