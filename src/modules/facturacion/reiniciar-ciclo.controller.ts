import { Controller, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { ReiniciarCicloService } from './reiniciar-ciclo.service';
import type { ResultadoReinicioCiclo } from '../../contracts';

/**
 * Isolated on purpose from `LotesController`/`FacturasController`, and gated
 * by `PlatformAdminGuard` rather than a CASL permission: this physically
 * deletes every financial document of the ACTIVE coproperty, so no role a
 * customer's administrator could hold may ever reach it. See
 * `ReiniciarCicloService` for the full reasoning.
 */
@Controller('facturacion')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class ReiniciarCicloController {
  constructor(private readonly reiniciarCiclo: ReiniciarCicloService) {}

  @Post('reiniciar-ciclo')
  reiniciar(): Promise<ResultadoReinicioCiclo> {
    return this.reiniciarCiclo.reiniciar();
  }
}
