// src/modules/entidades/entidades.controller.ts
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
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { EntidadesService } from './entidades.service';
import { ListarEntidadesDto } from './dto/listar-entidades.dto';
import {
  ActualizarEntidadDto,
  CrearEntidadDto,
} from './dto/guardar-entidad.dto';
import type { EntidadAdministradora, Paginado } from '../../contracts';

/**
 * The platform's catalogue of managing entities — companies that administer
 * several coproperties at once. Mirrors "Entidades Administradoras" in the
 * "Instalación" panel of the system this replaces.
 *
 * `PlatformAdminGuard`, not `PoliciesGuard`: a customer's own administrator,
 * however senior, has no business editing this catalogue — it exists above
 * any coproperty they could be assigned to.
 *
 * No DELETE: an entity is retired via `PATCH { estado: 'inactivo' }`, which
 * suspends the access its assignments grant without touching the buildings it
 * once administered.
 */
@Controller('entidades-administradoras')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class EntidadesController {
  constructor(private readonly entidades: EntidadesService) {}

  @Get()
  findAll(
    @Query() query: ListarEntidadesDto,
  ): Promise<Paginado<EntidadAdministradora>> {
    return this.entidades.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<EntidadAdministradora> {
    return this.entidades.findOne(id);
  }

  @Post()
  create(@Body() dto: CrearEntidadDto): Promise<EntidadAdministradora> {
    return this.entidades.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarEntidadDto,
  ): Promise<EntidadAdministradora> {
    return this.entidades.update(id, dto);
  }
}
