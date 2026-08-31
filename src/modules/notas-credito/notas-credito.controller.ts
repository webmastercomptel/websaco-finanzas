import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotasCreditoService } from './notas-credito.service';
import { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';
import type { NotaCredito } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'NotaCredito'` throughout, `create`/`read`/`update`/`annul` per
 * action (design §5) — CASL's `NotaCredito` subject and `notas-credito`
 * module key are already registered (verified in Task 3); no CASL code
 * changes are needed for this module. GET routes land in Task 9, `/aplicar`
 * in Task 7, `/anular` in Task 8.
 */
@Controller('notas-credito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasCreditoController {
  constructor(private readonly notasCredito: NotasCreditoService) {}

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaCredito' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaCreditoDto,
  ): Promise<NotaCredito> {
    // PoliciesGuard already required a NotaCredito/create permission, which
    // only an account with an active assignment can hold — accountId is
    // guaranteed set here, same reasoning as RecibosController.crear().
    return this.notasCredito.crear(user.accountId!, dto);
  }
}
