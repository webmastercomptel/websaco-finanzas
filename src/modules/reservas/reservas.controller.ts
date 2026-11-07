// src/modules/reservas/reservas.controller.ts
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
import type {
  DisponibilidadEspacio,
  Reserva,
  ReservaSolicitud,
  ReservasStats,
} from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarEstadoReservaDto } from './dto/actualizar-estado-reserva.dto';
import { CrearReservaDto } from './dto/guardar-reserva.dto';
import { ListarDisponibilidadDto } from './dto/listar-disponibilidad.dto';
import { ReservasService } from './reservas.service';

/**
 * Staff side of the reservations: `read` (`reservas.ver`) lists, queues and
 * counts them; everything that changes one needs `approve` (`reservas.aprobar`).
 *
 * Registering a booking on somebody's behalf and cancelling one are writes that
 * would naturally be `manage Reserva`, but the permission catalog has no
 * `reservas.gestionar` key (only `reservas.ver` and `reservas.aprobar`), so no
 * role could ever hold `manage`. They require `approve` too: whoever may answer
 * a request may also register and cancel bookings, which is what the system
 * this replaces gave them. Do not "simplify" a write route down to `read`, and do
 * not add a catalog key just for this.
 *
 * Residents never come through here: they carry no permissions and use
 * `ReservasPortalController` (`/portal/reservas`), which only ever reaches their
 * own bookings.
 */
@Controller('reservas')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class ReservasController {
  constructor(private readonly reservas: ReservasService) {}

  @Get('solicitudes')
  @CheckAbility({ action: 'read', subject: 'Reserva' })
  solicitudes(): Promise<ReservaSolicitud[]> {
    return this.reservas.listarSolicitudes();
  }

  @Get('stats')
  @CheckAbility({ action: 'read', subject: 'Reserva' })
  estadisticas(): Promise<ReservasStats> {
    return this.reservas.estadisticas();
  }

  @Get(':espacioId/disponibilidad')
  @CheckAbility({ action: 'read', subject: 'Reserva' })
  disponibilidad(
    @Param('espacioId') espacioId: string,
    @Query() consulta: ListarDisponibilidadDto,
  ): Promise<DisponibilidadEspacio> {
    return this.reservas.disponibilidad(espacioId, consulta.fecha);
  }

  @Get()
  @CheckAbility({ action: 'read', subject: 'Reserva' })
  listar(): Promise<Reserva[]> {
    return this.reservas.listar();
  }

  @Post()
  @CheckAbility({ action: 'approve', subject: 'Reserva' })
  crear(
    @Body() dto: CrearReservaDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Reserva> {
    return this.reservas.crearComoPersonal(dto, user);
  }

  @Patch(':id/estado')
  @CheckAbility({ action: 'approve', subject: 'Reserva' })
  actualizarEstado(
    @Param('id') id: string,
    @Body() dto: ActualizarEstadoReservaDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Reserva> {
    return this.reservas.cambiarEstado(id, dto, user);
  }
}
