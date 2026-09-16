import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { AdicionContabilidadService } from './adicion-contabilidad.service';
import type {
  LoteContabilidad,
  RespuestaAdicionContabilidad,
} from '../../contracts';

/**
 * Exports the current period's new accounting movement as MOVMES.csv/
 * MOVMESDO.csv for the target accounting system — see
 * `AdicionContabilidadService` for the full mechanics.
 */
@Controller('adicion-contabilidad')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class AdicionContabilidadController {
  constructor(
    private readonly adicionContabilidad: AdicionContabilidadService,
  ) {}

  @Get('lotes')
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  listar(): Promise<LoteContabilidad[]> {
    return this.adicionContabilidad.listar();
  }

  @Post('generar')
  @CheckAbility({ action: 'create', subject: 'Configuracion' })
  generar(
    @CurrentUser() user: IRequestUser,
  ): Promise<RespuestaAdicionContabilidad> {
    return this.adicionContabilidad.generar(user.accountId!);
  }
}
