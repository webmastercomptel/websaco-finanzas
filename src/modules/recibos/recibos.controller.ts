import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RecibosService } from './recibos.service';
import { CrearReciboDto } from './dto/crear-recibo.dto';
import type { Recibo } from '../../contracts';
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
}
