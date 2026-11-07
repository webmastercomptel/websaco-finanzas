// src/modules/reservas/reservas-portal.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { DisponibilidadEspacio, Reserva } from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { CrearReservaPortalDto } from './dto/guardar-reserva-portal.dto';
import { ListarDisponibilidadDto } from './dto/listar-disponibilidad.dto';
import { ReservasService } from './reservas.service';

/**
 * Resident side of the reservations: see what is taken, request a booking from a
 * unit they hold, list their own and cancel one of them. Guarded by
 * `PortalGuard` (the caller must hold a unit of the ACTIVE coproperty, which must
 * have contracted the module) and deliberately NOT by CASL: residents carry no
 * permissions, and putting these routes behind `PoliciesGuard` would lock out
 * exactly the people they are for.
 *
 * Authorization is data-level instead: every handler reaches the service through
 * a `...Propia` / `...Residente` method that narrows the query to bookings the
 * caller requested, so somebody else's booking is a 404. There is no approve,
 * reject, "all bookings", queue or stats route here and must not be one.
 */
@Controller('portal/reservas')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class ReservasPortalController {
  constructor(private readonly reservas: ReservasService) {}

  @Get(':espacioId/disponibilidad')
  disponibilidad(
    @Param('espacioId') espacioId: string,
    @Query() consulta: ListarDisponibilidadDto,
  ): Promise<DisponibilidadEspacio> {
    return this.reservas.disponibilidad(espacioId, consulta.fecha);
  }

  @Get()
  listar(@CurrentUser() user: IRequestUser): Promise<Reserva[]> {
    return this.reservas.listarPropias(user);
  }

  @Post()
  crear(
    @Body() dto: CrearReservaPortalDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Reserva> {
    return this.reservas.crearComoResidente(dto, user);
  }

  @Patch(':id/cancelar')
  cancelar(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<Reserva> {
    return this.reservas.cancelarPropia(id, user);
  }
}
