// src/modules/terceros/terceros.controller.ts
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
import { TercerosService } from './terceros.service';
import { ListarTercerosDto } from './dto/listar-terceros.dto';
import {
  ActualizarTerceroDto,
  CrearTerceroDto,
} from './dto/guardar-tercero.dto';
import type { Paginado, Tercero } from '../../contracts';

/**
 * Parties of the active coproperty — who a unit's charges are billed to.
 *
 * Guards in this order, always: authentication first, then authorization —
 * PoliciesGuard reads `request.user`, which the first one puts there.
 *
 * **There is no DELETE, and adding one would be a mistake.** A party is
 * retired by setting `estado: 'inactivo'`, which stops it being offered as a
 * new unit's holder without touching a single document that already names
 * it — see the note on the Tercero schema for why history must never rewrite
 * itself.
 */
@Controller('terceros')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class TercerosController {
  constructor(private readonly terceros: TercerosService) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Tercero' })
  findAll(@Query() query: ListarTercerosDto): Promise<Paginado<Tercero>> {
    return this.terceros.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Tercero' })
  findOne(@Param('id') id: string): Promise<Tercero> {
    return this.terceros.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Tercero' })
  create(@Body() dto: CrearTerceroDto): Promise<Tercero> {
    return this.terceros.create(dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Tercero' })
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarTerceroDto,
  ): Promise<Tercero> {
    return this.terceros.update(id, dto);
  }
}
