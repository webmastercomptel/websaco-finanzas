// src/modules/inmuebles/inmuebles.controller.ts
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
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { InmueblesService } from './inmuebles.service';
import { ListarInmueblesDto } from './dto/listar-inmuebles.dto';
import {
  ActualizarInmuebleDto,
  CrearInmuebleDto,
} from './dto/guardar-inmueble.dto';
import { ImportarInmueblesDto } from './dto/importar-inmuebles.dto';
import type {
  Inmueble,
  Paginado,
  ResultadoImportacionInmuebles,
} from '../../contracts';

/**
 * Units of the active coproperty.
 *
 * Guards in this order, always: authentication first, then authorization —
 * PoliciesGuard reads `request.user`, which the first one puts there.
 *
 * Reading and maintaining are separate permissions. Somebody who reads the
 * arrears report is not thereby entitled to rewrite who owns a unit, and
 * granting both with one key is how that happens by accident.
 *
 * **There is no DELETE, and adding one would be a mistake.** A unit is retired
 * by setting `estado: 'inactivo'`, which stops it being billed and keeps every
 * document ever issued against it readable. Removing the row would orphan those
 * documents — in accounting terms, losing the money.
 */
@Controller('inmuebles')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class InmueblesController {
  constructor(private readonly inmuebles: InmueblesService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  findAll(@Query() query: ListarInmueblesDto): Promise<Paginado<Inmueble>> {
    return this.inmuebles.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  findOne(@Param('id') id: string): Promise<Inmueble> {
    return this.inmuebles.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Inmueble' })
  create(@Body() dto: CrearInmuebleDto): Promise<Inmueble> {
    return this.inmuebles.create(dto);
  }

  /**
   * Loads a building's roster in one file: a unit and, inline, the party
   * that answers for it. Gated the same as a single `create` — importing is
   * bulk creation, not a separate capability.
   */
  @Post('importar')
  @CheckAbility({ action: 'create', subject: 'Inmueble' })
  importar(
    @Body() dto: ImportarInmueblesDto,
  ): Promise<ResultadoImportacionInmuebles> {
    return this.inmuebles.importar(dto);
  }

  /**
   * Partial edit. Also how a unit is activated or deactivated, through
   * `estado` — deliberately the same endpoint, because retiring a unit is a
   * change to it, not a separate kind of act.
   */
  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Inmueble' })
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarInmuebleDto,
  ): Promise<Inmueble> {
    return this.inmuebles.update(id, dto);
  }
}
