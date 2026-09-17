// src/modules/inmuebles/inmuebles.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { InmueblesService } from './inmuebles.service';
import { ValoresRecurrentesService } from './valores-recurrentes.service';
import { InmueblesReporteService } from './inmuebles-reporte.service';
import { InmueblesEliminacionService } from './inmuebles-eliminacion.service';
import { ListarInmueblesDto } from './dto/listar-inmuebles.dto';
import {
  ActualizarInmuebleDto,
  CrearInmuebleDto,
} from './dto/guardar-inmueble.dto';
import { ImportarInmueblesDto } from './dto/importar-inmuebles.dto';
import { GuardarValoresRecurrentesDto } from './dto/guardar-valores-recurrentes.dto';
import { ImportarValoresRecurrentesMasivoDto } from './dto/importar-valores-recurrentes.dto';
import type {
  Inmueble,
  Paginado,
  ProgresoImportacion,
  ResultadoImportacionInmuebles,
  ResultadoImportacionValoresRecurrentes,
  ValorRecurrente,
  ValorRecurrenteMasivo,
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
 * Every unit here is active by definition — there is no `estado` to toggle
 * (see `ActualizarInmuebleDto`'s own note). DELETE exists, unlike most of
 * this domain, but only for a unit that has never been billed — see
 * `InmueblesEliminacionService`, gated by `manage` (stricter than the
 * `update` editing needs), same reasoning as `ConceptosController`'s own
 * DELETE.
 */
@Controller('inmuebles')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class InmueblesController {
  constructor(
    private readonly inmuebles: InmueblesService,
    private readonly valoresRecurrentes: ValoresRecurrentesService,
    private readonly reporte: InmueblesReporteService,
    private readonly eliminacion: InmueblesEliminacionService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  findAll(@Query() query: ListarInmueblesDto): Promise<Paginado<Inmueble>> {
    return this.inmuebles.findAll(query);
  }

  /**
   * A printable roster of every active unit — código, titular, área,
   * coeficiente, valores recurrentes. Route sits before `:id` so it is
   * never swallowed by that param.
   */
  @Get('listado.pdf')
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  async generarListadoPdf(
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const bytes = await this.reporte.generarListadoPdf();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="listado-inmuebles.pdf"',
    });
    res.send(Buffer.from(bytes));
  }

  /**
   * Every active unit's recurring amounts, coproperty-wide — what the bulk
   * "Valores Recurrentes" export builds its editable template from. Route
   * sits before `:id`, same reasoning as `listado.pdf` above: otherwise
   * "valores-recurrentes" is read as an id.
   */
  @Get('valores-recurrentes')
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  obtenerValoresRecurrentesMasivo(): Promise<ValorRecurrenteMasivo[]> {
    return this.valoresRecurrentes.obtenerTodos();
  }

  /**
   * Bulk-loads recurring amounts by unit código, from a file parsed on the
   * frontend. Gated by `update`, not `create`: unlike `POST /importar`,
   * this never creates or deletes an Inmueble, only edits ValorRecurrente
   * rows of units that already exist — see `ValoresRecurrentesService.importarMasivo`.
   */
  @Post('valores-recurrentes/importar')
  @CheckAbility({ action: 'update', subject: 'Inmueble' })
  importarValoresRecurrentesMasivo(
    @Body() dto: ImportarValoresRecurrentesMasivoDto,
  ): Promise<ResultadoImportacionValoresRecurrentes> {
    return this.valoresRecurrentes.importarMasivo(dto);
  }

  /**
   * Polled while `POST valores-recurrentes/importar` is in flight — same
   * reasoning as `obtenerProgresoImportacion` above, separate row (see
   * `TipoImportacion`) so the two bulk imports never share progress state.
   */
  @Get('valores-recurrentes/importar/progreso')
  @CheckAbility({ action: 'update', subject: 'Inmueble' })
  obtenerProgresoImportacionValoresRecurrentes(): Promise<ProgresoImportacion | null> {
    return this.valoresRecurrentes.obtenerProgresoImportacion();
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
   *
   * REPLACES the roster: every call first wipes every existing unit of the
   * active coproperty that has no Factura against it — see
   * `InmueblesService.importar`. Not additive, by design.
   */
  @Post('importar')
  @CheckAbility({ action: 'create', subject: 'Inmueble' })
  importar(
    @Body() dto: ImportarInmueblesDto,
  ): Promise<ResultadoImportacionInmuebles> {
    return this.inmuebles.importar(dto);
  }

  /**
   * Polled while `POST /importar` is in flight — null once nothing is
   * running (either it finished, or nothing was ever started). See
   * `ProgresoImportacionService`.
   */
  @Get('importar/progreso')
  @CheckAbility({ action: 'create', subject: 'Inmueble' })
  obtenerProgresoImportacion(): Promise<ProgresoImportacion | null> {
    return this.inmuebles.obtenerProgresoImportacion();
  }

  /** Partial edit. */
  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'Inmueble' })
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarInmuebleDto,
  ): Promise<Inmueble> {
    return this.inmuebles.update(id, dto);
  }

  /**
   * Hard delete — refused when the unit already has a Factura. See
   * `InmueblesEliminacionService`.
   */
  @Delete(':id')
  @HttpCode(204)
  @CheckAbility({ action: 'manage', subject: 'Inmueble' })
  eliminar(@Param('id') id: string): Promise<void> {
    return this.eliminacion.eliminar(id);
  }

  /**
   * The unit's recurring monthly amounts — one entry per concept in the
   * building's catalog. See the note on `ValoresRecurrentesService`.
   */
  @Get(':id/valores-recurrentes')
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  obtenerValoresRecurrentes(
    @Param('id') id: string,
  ): Promise<ValorRecurrente[]> {
    return this.valoresRecurrentes.obtener(id);
  }

  @Put(':id/valores-recurrentes')
  @CheckAbility({ action: 'update', subject: 'Inmueble' })
  guardarValoresRecurrentes(
    @Param('id') id: string,
    @Body() dto: GuardarValoresRecurrentesDto,
  ): Promise<ValorRecurrente[]> {
    return this.valoresRecurrentes.guardar(id, dto);
  }
}
