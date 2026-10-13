import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  AdicionContabilidadService,
  type ActorAdicion,
} from './adicion-contabilidad.service';
import type {
  ArchivosLoteContabilidad,
  LoteContabilidad,
  RespuestaAdicionContabilidad,
} from '../../contracts';

/** The audit log needs a non-empty name; an account without one is shown
 *  by its email. */
const actorDe = (user: IRequestUser): ActorAdicion => ({
  accountId: user.accountId!,
  nombre: user.nombre?.trim() || user.email,
});

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
    return this.adicionContabilidad.generar(actorDe(user));
  }

  /** A past lote's two files again — for when a download never arrived. */
  @Get('lotes/:id/archivos')
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  archivos(@Param('id') id: string): Promise<ArchivosLoteContabilidad> {
    return this.adicionContabilidad.archivos(id);
  }

  /** Releases a lote's entries so the next generation exports them again. */
  @Post('lotes/:id/desmarcar')
  @CheckAbility({ action: 'create', subject: 'Configuracion' })
  desmarcar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<LoteContabilidad> {
    return this.adicionContabilidad.desmarcar(id, actorDe(user));
  }
}
