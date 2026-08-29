// src/modules/conceptos/conceptos.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { ConceptosService } from './conceptos.service';
import {
  ActualizarConceptoDto,
  CrearConceptoDto,
} from './dto/guardar-concepto.dto';
import type { ConceptoCobro } from '../../contracts';

/**
 * The billing concepts ("Cargos") one coproperty can charge. Nested under the
 * building it belongs to, never under a route of its own — a concept has no
 * meaning outside one coproperty.
 *
 * `PlatformAdminGuard`, same as CopropiedadesController — a temporary
 * arrangement while there is no screen yet for a building's own
 * administrator. See the note on ConceptosService.
 *
 * No DELETE: a concept is retired via `PATCH { activo: false }`.
 */
@Controller('copropiedades/:copropiedadId/conceptos')
@UseGuards(FirebaseAuthGuard, PlatformAdminGuard)
export class ConceptosController {
  constructor(private readonly conceptos: ConceptosService) {}

  @Get()
  findAll(
    @Param('copropiedadId') copropiedadId: string,
  ): Promise<ConceptoCobro[]> {
    return this.conceptos.findAll(copropiedadId);
  }

  @Post()
  create(
    @Param('copropiedadId') copropiedadId: string,
    @Body() dto: CrearConceptoDto,
  ): Promise<ConceptoCobro> {
    return this.conceptos.create(copropiedadId, dto);
  }

  @Patch(':id')
  update(
    @Param('copropiedadId') copropiedadId: string,
    @Param('id') id: string,
    @Body() dto: ActualizarConceptoDto,
  ): Promise<ConceptoCobro> {
    return this.conceptos.update(copropiedadId, id, dto);
  }
}
