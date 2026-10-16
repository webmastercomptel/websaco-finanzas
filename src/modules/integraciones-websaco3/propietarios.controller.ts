// src/modules/integraciones-websaco3/propietarios.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { PropietariosWebsaco3 } from '../../contracts';
import { ConsultarPropietariosDto } from './dto/consultar-propietarios.dto';
import { FirmaWebsaco3Guard } from './firma-websaco3.guard';
import { PropietariosService } from './propietarios.service';

/**
 * Read-only holders snapshot that WebSaco3 pulls (see
 * `docs/runbooks/publicacion-websaco3.md`). Its ONLY guard is
 * `FirmaWebsaco3Guard`: no `FirebaseAuthGuard`, no `PoliciesGuard`, no
 * `@CheckAbility`. The caller is a machine with no user, so there is no
 * identity to check permissions against, and no tenant either: the tenant is
 * the coproperty named by the signed `websaco3CopropiedadId` (the
 * `X-CoProperty-Id` header is never read). Same reasoning as
 * `PublicacionFacturasController`.
 *
 * Guards run before pipes: an unsigned caller gets 401 even for a malformed
 * id. The global interceptor wraps the return value in `{ statusCode, data }`.
 */
@Controller('integraciones/websaco3')
@UseGuards(FirmaWebsaco3Guard)
export class PropietariosController {
  constructor(private readonly service: PropietariosService) {}

  @Get('propietarios')
  obtener(
    @Query() consulta: ConsultarPropietariosDto,
  ): Promise<PropietariosWebsaco3> {
    return this.service.obtener(consulta.websaco3CopropiedadId);
  }
}
