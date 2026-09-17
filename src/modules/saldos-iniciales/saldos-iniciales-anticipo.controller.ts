import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SaldosInicialesAnticipoService } from './saldos-iniciales-anticipo.service';
import { ImportarSaldosInicialesAnticipoDto } from './dto/importar-saldos-iniciales-anticipo.dto';
import { AnularSaldoInicialAnticipoDto } from './dto/anular-saldo-inicial-anticipo.dto';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  ProgresoImportacion,
  ResultadoImportacionSaldosInicialesAnticipo,
  SaldoInicialAnticipo,
} from '../../contracts';

@Controller('saldos-iniciales-anticipo')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class SaldosInicialesAnticipoController {
  constructor(
    private readonly saldosInicialesAnticipo: SaldosInicialesAnticipoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'SaldoInicialAnticipo' })
  listar(): Promise<SaldoInicialAnticipo[]> {
    return this.saldosInicialesAnticipo.listar();
  }

  @Post('importar')
  @CheckAbility({ action: 'create', subject: 'SaldoInicialAnticipo' })
  importar(
    @CurrentUser() user: IRequestUser,
    @Body() dto: ImportarSaldosInicialesAnticipoDto,
  ): Promise<ResultadoImportacionSaldosInicialesAnticipo> {
    return this.saldosInicialesAnticipo.importar(user.accountId!, dto);
  }

  /**
   * Polled while `POST /importar` is in flight — null once nothing is
   * running. See `ProgresoImportacionService`.
   */
  @Get('importar/progreso')
  @CheckAbility({ action: 'create', subject: 'SaldoInicialAnticipo' })
  obtenerProgresoImportacion(): Promise<ProgresoImportacion | null> {
    return this.saldosInicialesAnticipo.obtenerProgresoImportacion();
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'SaldoInicialAnticipo' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularSaldoInicialAnticipoDto,
  ): Promise<SaldoInicialAnticipo> {
    return this.saldosInicialesAnticipo.anular(id, dto, user.accountId!);
  }
}
