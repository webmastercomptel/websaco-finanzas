// src/modules/notificaciones/notificaciones.controller.ts
import { Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { Notificacion } from '../../contracts';
import { AuthenticatedOnly } from '../casl/check-ability.decorator';
import { NotificacionesService } from './notificaciones.service';

/**
 * The caller's own inbox. Open to any signed-in person, owners and tenants
 * included, on purpose: it carries no financial data and every query is bound
 * to the caller's account and the active coproperty, so there is nothing to
 * authorize beyond who is asking.
 */
@Controller('notificaciones')
@UseGuards(FirebaseAuthGuard)
@AuthenticatedOnly()
export class NotificacionesController {
  constructor(private readonly notificaciones: NotificacionesService) {}

  @Get()
  findAll(@CurrentUser() user: IRequestUser): Promise<Notificacion[]> {
    return this.notificaciones.findAll(user);
  }

  /** Declared before `:id/leer` so `leer-todas` is never read as an id. */
  @Patch('leer-todas')
  marcarTodasLeidas(
    @CurrentUser() user: IRequestUser,
  ): Promise<{ actualizadas: number }> {
    return this.notificaciones.marcarTodasLeidas(user);
  }

  @Patch(':id/leer')
  marcarLeida(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
  ): Promise<Notificacion> {
    return this.notificaciones.marcarLeida(id, user);
  }
}
