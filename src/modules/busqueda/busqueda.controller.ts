// src/modules/busqueda/busqueda.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAnyAbility } from '../casl/check-ability.decorator';
import { BusquedaService } from './busqueda.service';
import { BuscarDto } from './dto/buscar.dto';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { RespuestaBusqueda } from '../../contracts';

@Controller('busqueda')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class BusquedaController {
  constructor(private readonly busqueda: BusquedaService) {}

  /**
   * Gate: at least one of the seven reads, so a caller who can see nothing
   * searchable gets a 403 instead of an empty object. What each group then
   * shows is decided per subject inside the service (a group the caller cannot
   * read is omitted), because this route is one door onto several subjects.
   * Notas de débito are the `OtraNota` subject, as in their own controller.
   */
  @Get()
  @CheckAnyAbility(
    { action: 'read', subject: 'Factura' },
    { action: 'read', subject: 'Recibo' },
    { action: 'read', subject: 'NotaCredito' },
    { action: 'read', subject: 'OtraNota' },
    { action: 'read', subject: 'NotaContable' },
    { action: 'read', subject: 'NotaAnticipo' },
    { action: 'read', subject: 'Inmueble' },
  )
  buscar(
    @CurrentUser() user: IRequestUser,
    @Query() query: BuscarDto,
  ): Promise<RespuestaBusqueda> {
    return this.busqueda.buscar(user, query);
  }
}
