import { Controller, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { ReiniciarCicloService } from './reiniciar-ciclo.service';
import type { ResultadoReinicioCiclo } from '../../contracts';

/**
 * Isolated on purpose from `LotesController`/`FacturasController` — this
 * subject/action pair (`CicloFacturacionPrueba`/`reiniciar`) exists nowhere
 * else, so a role holding it never gains any power over real Facturas. See
 * `ReiniciarCicloService` for the full safety reasoning.
 */
@Controller('facturacion')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class ReiniciarCicloController {
  constructor(private readonly reiniciarCiclo: ReiniciarCicloService) {}

  @Post('reiniciar-ciclo')
  @CheckAbility({ action: 'reiniciar', subject: 'CicloFacturacionPrueba' })
  reiniciar(): Promise<ResultadoReinicioCiclo> {
    return this.reiniciarCiclo.reiniciar();
  }
}
