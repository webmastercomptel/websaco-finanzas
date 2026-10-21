import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  InterfazComptableService,
  type ActorComptable,
} from './interfaz-comptable.service';
import type {
  EstadoInterfazComptable,
  LoteComptable,
  PendientesComptable,
  ResultadoEnvioComptable,
  ResultadoSimulacionComptable,
} from '../../contracts';

/** The audit log and the payload need a non-empty name; an account without
 *  one is shown by its email. */
const actorDe = (user: IRequestUser): ActorComptable => ({
  accountId: user.accountId!,
  nombre: user.nombre?.trim() || user.email,
});

/**
 * "Interfaz a Comptable" — manual, signed push of the period's asientos to
 * Comptable. See `InterfazComptableService` for the flow. Tenant from the
 * request context; permissions on the `InterfazComptable` subject: `read`
 * (estado, pendientes, lotes), `create` (simular, enviar, reintentar),
 * `annul` (retirar).
 */
@Controller('interfaz-comptable')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class InterfazComptableController {
  constructor(private readonly interfaz: InterfazComptableService) {}

  @Get('estado')
  @CheckAbility({ action: 'read', subject: 'InterfazComptable' })
  estado(): Promise<EstadoInterfazComptable> {
    return this.interfaz.estado();
  }

  @Get('pendientes')
  @CheckAbility({ action: 'read', subject: 'InterfazComptable' })
  pendientes(@CurrentUser() user: IRequestUser): Promise<PendientesComptable> {
    return this.interfaz.pendientes(actorDe(user));
  }

  @Post('simular')
  @HttpCode(200)
  @CheckAbility({ action: 'create', subject: 'InterfazComptable' })
  simular(
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoSimulacionComptable> {
    return this.interfaz.simular(actorDe(user));
  }

  @Post('enviar')
  @CheckAbility({ action: 'create', subject: 'InterfazComptable' })
  enviar(@CurrentUser() user: IRequestUser): Promise<ResultadoEnvioComptable> {
    return this.interfaz.enviar(actorDe(user));
  }

  @Get('lotes')
  @CheckAbility({ action: 'read', subject: 'InterfazComptable' })
  listar(): Promise<LoteComptable[]> {
    return this.interfaz.listar();
  }

  /** Re-sends a `pendiente` lote: same id, same entries. */
  @Post('lotes/:id/reintentar')
  @HttpCode(200)
  @CheckAbility({ action: 'create', subject: 'InterfazComptable' })
  reintentar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoEnvioComptable> {
    return this.interfaz.reintentar(id, actorDe(user));
  }

  /** Withdraws an `enviado` lote from Comptable and releases its entries. */
  @Post('lotes/:id/retirar')
  @HttpCode(200)
  @CheckAbility({ action: 'annul', subject: 'InterfazComptable' })
  retirar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<LoteComptable> {
    return this.interfaz.retirar(id, actorDe(user));
  }
}
