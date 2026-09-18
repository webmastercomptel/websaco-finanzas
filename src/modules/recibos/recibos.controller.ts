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
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RecibosService } from './recibos.service';
import { CrearReciboDto } from './dto/crear-recibo.dto';
import { AnularReciboDto } from './dto/anular-recibo.dto';
import { ListarRecibosDto } from './dto/listar-recibos.dto';
import type { Paginado, Recibo, ReciboDetalle } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'Recibo'` throughout, `create`/`read`/`annul` per action — same
 * one-subject-for-the-whole-lifecycle choice LotesController already made
 * for `'Factura'` (design §5). There is deliberately no `/aplicar` route —
 * a Recibo left with a pending anticipo (`unappliedAmount > 0`) is applied
 * from the `notas-anticipo` module instead, never from here (see
 * `NotasAnticipoService`).
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

  /**
   * Also the frontend's source for rendering a Recibo's PDF client-side —
   * `Recibo.documentDefinition` (frozen once, at `crear()` time — see
   * `RecibosService.congelarPresentacionRecibo`; no `?duplicado=true`
   * variant baked in, reprinting a duplicate copy is a client-side concern
   * now, not something this route does server-side) is just another field
   * on the same mapped contract, so there's no separate `:id/pdf` route
   * anymore — same conversion Factura's own controller already went
   * through.
   */
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

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'Recibo' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularReciboDto,
  ): Promise<Recibo> {
    // Same reasoning as crear()/aplicar() above for the non-null assertion:
    // PoliciesGuard already required a Recibo/annul permission, which only an
    // account with an active assignment can hold.
    return this.recibos.anular(id, dto, user.accountId!);
  }
}
