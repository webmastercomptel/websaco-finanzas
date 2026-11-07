// src/modules/busqueda-administracion/busqueda-administracion.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { RespuestaBusquedaAdministracion } from '../../contracts';
import { CheckAnyAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { BusquedaAdministracionService } from './busqueda-administracion.service';
import { BuscarAdministracionDto } from './dto/buscar-administracion.dto';

/**
 * Search over the building-management records. A separate route from the
 * financial `GET /busqueda` because a coproperty may have contracted only one
 * of the two products, and each route is licence-gated to its own; the unified
 * search box calls both and merges the answers (their group keys never overlap).
 *
 * Staff only. The source search had no permission check at all and let any
 * signed-in resident find other people's PQRs and bookings; residents get no
 * search here, and `PortalGuard` routes are not offered one.
 */
@Controller('busqueda-administracion')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class BusquedaAdministracionController {
  constructor(private readonly busqueda: BusquedaAdministracionService) {}

  /**
   * Gate: at least one searchable subject, so a caller who can see nothing gets
   * a 403 instead of an empty object. What each group then shows is decided per
   * subject inside the service (a group the caller cannot read is omitted).
   * `create Documento` is in the door because it is the ability that opens the
   * block-billing group, which a pure uploader holds without `read Documento`.
   */
  @Get()
  @CheckAnyAbility(
    { action: 'read', subject: 'Tarea' },
    { action: 'read', subject: 'Anuncio' },
    { action: 'read', subject: 'Pqr' },
    { action: 'read', subject: 'Mantenimiento' },
    { action: 'read', subject: 'Actividad' },
    { action: 'read', subject: 'Documento' },
    { action: 'read', subject: 'Zona' },
    { action: 'read', subject: 'Reserva' },
    { action: 'create', subject: 'Documento' },
  )
  buscar(
    @CurrentUser() user: IRequestUser,
    @Query() query: BuscarAdministracionDto,
  ): Promise<RespuestaBusquedaAdministracion> {
    return this.busqueda.buscar(user, query);
  }
}
