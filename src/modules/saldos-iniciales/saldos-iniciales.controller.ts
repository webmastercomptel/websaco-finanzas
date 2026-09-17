import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SaldosInicialesService } from './saldos-iniciales.service';
import { ImportarSaldosInicialesDto } from './dto/importar-saldos-iniciales.dto';
import { AnularSaldoInicialDto } from './dto/anular-saldo-inicial.dto';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  ProgresoImportacion,
  ResultadoImportacionSaldosIniciales,
  SaldoInicial,
} from '../../contracts';

@Controller('saldos-iniciales')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class SaldosInicialesController {
  constructor(private readonly saldosIniciales: SaldosInicialesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'SaldoInicial' })
  listar(): Promise<SaldoInicial[]> {
    return this.saldosIniciales.listar();
  }

  @Post('importar')
  @CheckAbility({ action: 'create', subject: 'SaldoInicial' })
  importar(
    @CurrentUser() user: IRequestUser,
    @Body() dto: ImportarSaldosInicialesDto,
  ): Promise<ResultadoImportacionSaldosIniciales> {
    return this.saldosIniciales.importar(user.accountId!, dto);
  }

  /**
   * Polled while `POST /importar` is in flight — null once nothing is
   * running (either it finished, or nothing was ever started). See
   * `ProgresoImportacionService`.
   */
  @Get('importar/progreso')
  @CheckAbility({ action: 'create', subject: 'SaldoInicial' })
  obtenerProgresoImportacion(): Promise<ProgresoImportacion | null> {
    return this.saldosIniciales.obtenerProgresoImportacion();
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'SaldoInicial' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularSaldoInicialDto,
  ): Promise<SaldoInicial> {
    return this.saldosIniciales.anular(id, dto, user.accountId!);
  }
}
