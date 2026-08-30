import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RecibosService } from './recibos.service';
import { CrearReciboDto } from './dto/crear-recibo.dto';
import { AplicarReciboDto } from './dto/aplicar-recibo.dto';
import { AnularReciboDto } from './dto/anular-recibo.dto';
import { ListarRecibosDto } from './dto/listar-recibos.dto';
import type { Paginado, Recibo, ReciboDetalle, ResultadoAplicacion } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'Recibo'` throughout, `create`/`read`/`update`/`annul` per
 * action — same one-subject-for-the-whole-lifecycle choice LotesController
 * already made for `'Factura'` (design §5). GET routes are added in Task
 * 10, `/aplicar` in Task 8, `/anular` in Task 9.
 */
@Controller('recibos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class RecibosController {
  constructor(private readonly recibos: RecibosService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findAll(@Query() query: ListarRecibosDto): Promise<Paginado<Recibo>> {
    return this.recibos.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findOne(@Param('id') id: string): Promise<ReciboDetalle> {
    return this.recibos.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearReciboDto,
  ): Promise<Recibo> {
    // PoliciesGuard already required a Recibo/create permission, which only
    // an account with an active assignment can hold — accountId is
    // guaranteed set here, same reasoning as LotesController.crear().
    return this.recibos.crear(user.accountId!, dto);
  }

  @Post(':id/aplicar')
  @CheckAbility({ action: 'update', subject: 'Recibo' })
  aplicar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AplicarReciboDto,
  ): Promise<ResultadoAplicacion> {
    return this.recibos.aplicar(id, dto, user.accountId!);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'Recibo' })
  anular(
    @Param('id') id: string,
    @Body() dto: AnularReciboDto,
  ): Promise<Recibo> {
    return this.recibos.anular(id, dto);
  }
}
