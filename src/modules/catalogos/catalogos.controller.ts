// src/modules/catalogos/catalogos.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { CatalogosService } from './catalogos.service';
import { ListarCiudadesDto } from './dto/listar-ciudades.dto';
import type {
  CiudadDian,
  DepartamentoDian,
  TipoIdentificacionDian,
} from '../../contracts';

/**
 * Static DIAN/DANE reference lists — no tenant, no permission beyond being
 * signed in. Every account, customer or platform, fills out a form with a
 * tipo de documento or a ciudad at some point, and none of that depends on
 * which coproperty (if any) is active — so this is the one controller in
 * the app with no `PoliciesGuard`/`@CheckAbility`: there is nothing here a
 * permission could scope, only a catalog everyone reads the same way.
 */
@Controller('catalogos')
@UseGuards(FirebaseAuthGuard)
export class CatalogosController {
  constructor(private readonly catalogos: CatalogosService) {}

  @Get('tipos-identificacion')
  tiposIdentificacion(): TipoIdentificacionDian[] {
    return this.catalogos.listarTiposIdentificacion();
  }

  @Get('departamentos')
  departamentos(): DepartamentoDian[] {
    return this.catalogos.listarDepartamentos();
  }

  @Get('ciudades')
  ciudades(@Query() query: ListarCiudadesDto): CiudadDian[] {
    return this.catalogos.listarCiudades(query.departamentoCodigo);
  }
}
