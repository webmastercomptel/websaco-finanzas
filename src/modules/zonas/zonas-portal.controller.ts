// src/modules/zonas/zonas-portal.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { Espacio } from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { ListarEspaciosDto } from './dto/listar-espacios.dto';
import { ZonasService } from './zonas.service';

/**
 * Resident side of the common areas: the list of what can be booked. Guarded by
 * `PortalGuard` (the caller must hold a unit of the ACTIVE coproperty, which
 * must have contracted the module) and deliberately NOT by CASL: residents carry
 * no permissions, and putting this route behind `PoliciesGuard` would lock out
 * exactly the people it is for.
 *
 * It serves the slim `Espacio` shape of the zones flagged `requiereReserva`,
 * never the staff `ZonaComun`. There is no write route here and must not be one.
 */
@Controller('portal/espacios')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class ZonasPortalController {
  constructor(private readonly zonas: ZonasService) {}

  @Get()
  listar(@Query() filtros: ListarEspaciosDto): Promise<Espacio[]> {
    return this.zonas.listarEspacios(filtros);
  }
}
