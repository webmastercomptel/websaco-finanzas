import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility, CheckAnyAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SaldosInicialesService } from './saldos-iniciales.service';
import { ImportarSaldosInicialesDto } from './dto/importar-saldos-iniciales.dto';
import { ListarSaldosInicialesDto } from './dto/listar-saldos-iniciales.dto';
import { ListarSaldosInicialesAplicablesDto } from './dto/listar-saldos-iniciales-aplicables.dto';
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
  listar(@Query() query: ListarSaldosInicialesDto): Promise<SaldoInicial[]> {
    return this.saldosIniciales.listar(query);
  }

  /**
   * Read-only consumer route for the payment flows: the unit's active Saldos
   * Iniciales with saldoPendiente > 0. Gated by the WRITES that consume them
   * (anyone who can make a Recibo, a Nota Crédito or an Anticipo application
   * must see what they apply against) plus the admin read — NOT by the
   * Saldos Iniciales permission, which governs loading/importing/annulling.
   * Declared before any param route so it is never read as an `:id`.
   */
  @Get('aplicables')
  @CheckAnyAbility(
    { action: 'create', subject: 'Recibo' },
    { action: 'create', subject: 'NotaCredito' },
    { action: 'create', subject: 'NotaAnticipo' },
    { action: 'read', subject: 'SaldoInicial' },
  )
  listarAplicables(
    @Query() query: ListarSaldosInicialesAplicablesDto,
  ): Promise<SaldoInicial[]> {
    return this.saldosIniciales.listarAplicables(query);
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
