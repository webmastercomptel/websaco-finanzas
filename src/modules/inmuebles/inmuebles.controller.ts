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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility, CheckAnyAbility } from '../casl/check-ability.decorator';
import { InmueblesService } from './inmuebles.service';
import { ValoresRecurrentesService } from './valores-recurrentes.service';
import { InmueblesReporteService } from './inmuebles-reporte.service';
import { InmueblesEliminacionService } from './inmuebles-eliminacion.service';
import { InmueblesSaldosService } from './inmuebles-saldos.service';
import { InmueblesBajaService } from './inmuebles-baja.service';
import { ListarInmueblesDto } from './dto/listar-inmuebles.dto';
import { ConsultarSaldosInmueblesDto } from './dto/consultar-saldos-inmuebles.dto';
import {
  ActualizarInmuebleDto,
  CrearInmuebleDto,
} from './dto/guardar-inmueble.dto';
import { ImportarInmueblesDto } from './dto/importar-inmuebles.dto';
import { DarDeBajaInmueblesDto } from './dto/dar-de-baja-inmuebles.dto';
import { GuardarValoresRecurrentesDto } from './dto/guardar-valores-recurrentes.dto';
import { ImportarValoresRecurrentesMasivoDto } from './dto/importar-valores-recurrentes.dto';
import type {
  ExportacionImportacionInmuebles,
  Inmueble,
  Paginado,
  ResultadoDarDeBajaInmuebles,
  ProgresoImportacion,
  ResultadoImportacionInmuebles,
  ResultadoImportacionValoresRecurrentes,
  RespuestaListadoInmuebles,
  SaldoInmueble,
  ValorRecurrente,
  ValorRecurrenteMasivo,
  VistaPreviaImportacionInmuebles,
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
 * `estado` (activo/inactivo — see `ActualizarInmuebleDto`'s own note) is a
 * soft retire that only affects future billing eligibility; both states
 * still list and edit here. DELETE exists on top of that, unlike most of
 * this domain, but only for a unit that has never been billed at all — see
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
    private readonly saldos: InmueblesSaldosService,
    private readonly baja: InmueblesBajaService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  findAll(@Query() query: ListarInmueblesDto): Promise<Paginado<Inmueble>> {
    return this.inmuebles.findAll(query);
  }

  /**
   * Outstanding balance of up to 50 units in one call (`?ids=a,b,c`) — what
   * the "Nueva factura" unit picker shows beside each candidate. Gated by
   * EITHER reading cartera OR creating invoices (OR semantics), because
   * whoever can issue an invoice must see what the unit already owes without
   * also being entitled to the full arrears report, and whoever reads cartera
   * already sees these numbers there. Only units of the active coproperty are
   * answered. Route sits before `:id`, same reasoning as `listado.pdf` below:
   * otherwise "saldos" is read as an id.
   */
  @Get('saldos')
  @CheckAnyAbility(
    { action: 'read', subject: 'Consulta' },
    { action: 'create', subject: 'Factura' },
  )
  consultarSaldos(
    @Query() query: ConsultarSaldosInmueblesDto,
  ): Promise<SaldoInmueble[]> {
    return this.saldos.consultar(query);
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
   * Same roster as `listado.pdf`, as JSON — what the frontend's Excel
   * export button builds its workbook from, so it never falls behind the
   * PDF's own numbers. Route sits before `:id`, same reasoning as
   * `listado.pdf` above.
   */
  @Get('listado')
  @CheckAbility({ action: 'read', subject: 'Inmueble' })
  obtenerListado(): Promise<RespuestaListadoInmuebles> {
    return this.reporte.obtenerListado();
  }

  /**
   * The roster in the import's exact shape (25 columns, every unit active or
   * inactive, titular columns joined) — what the frontend's "Descargar
   * inmuebles" builds the editable import workbook from. It exposes the
   * titulares' personal data, so it needs BOTH read on `Inmueble` and read on
   * `Tercero` (`CheckAbility` rules are AND-ed): the unit permission alone
   * must not leak who owns what. Route sits before `:id`, same reasoning as
   * `listado.pdf` above: otherwise "exportar-importacion" is read as an id.
   */
  @Get('exportar-importacion')
  @CheckAbility(
    { action: 'read', subject: 'Inmueble' },
    { action: 'read', subject: 'Tercero' },
  )
  exportarImportacion(): Promise<ExportacionImportacionInmuebles> {
    return this.inmuebles.exportarImportacion();
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
   * that answers for it.
   *
   * UPSERT BY CODE, never destructive: a row of an existing code patches that
   * unit (only the fields the row sent, never its `codigo`), a row of a new
   * code creates it, and nothing is ever deleted — see
   * `InmueblesService.importar`. Because it both creates AND edits units it
   * needs `create` AND `update` on `Inmueble` (rules are AND-ed): a role that
   * could only create must not be able to rewrite existing units through a
   * file. It deliberately does NOT also require `update` on `Tercero`: the
   * titular refresh on re-import already existed under the old `create`-only
   * gate, and adding it now could lock the accountant role out of loading its
   * own roster.
   */
  @Post('importar')
  @CheckAbility(
    { action: 'create', subject: 'Inmueble' },
    { action: 'update', subject: 'Inmueble' },
  )
  importar(
    @Body() dto: ImportarInmueblesDto,
  ): Promise<ResultadoImportacionInmuebles> {
    return this.inmuebles.importar(dto);
  }

  /**
   * Dry run of `POST /importar`: same body, same gate (it exposes the
   * roster's state and how the file would change it, so it needs what the
   * import needs), but it WRITES NOTHING — no unit, no Tercero, no progress
   * row. Answers what would be created, updated, rejected and left out, with
   * the import's own validators. Declared next to `importar`, before `:id`.
   */
  @Post('importar/previsualizar')
  @CheckAbility(
    { action: 'create', subject: 'Inmueble' },
    { action: 'update', subject: 'Inmueble' },
  )
  previsualizarImportacion(
    @Body() dto: ImportarInmueblesDto,
  ): Promise<VistaPreviaImportacionInmuebles> {
    return this.inmuebles.previsualizarImportacion(dto);
  }

  /**
   * Retires units by code — the explicit, separate counterpart of the import's
   * "absent from the file" report. LOGICAL only (`estado` to inactive,
   * nothing deleted, reversible by editing the unit back to `activo`), so it
   * needs `update` on `Inmueble` and nothing stronger than the edit form
   * already asks for. One audit entry per request. Declared next to the import
   * routes, before the `:id` ones.
   */
  @Post('dar-de-baja')
  @CheckAbility({ action: 'update', subject: 'Inmueble' })
  darDeBaja(
    @Body() dto: DarDeBajaInmueblesDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<ResultadoDarDeBajaInmuebles> {
    return this.baja.darDeBaja(dto, {
      // PoliciesGuard already rejected callers without permissions, and only a
      // provisioned local account has any — same assumption as the other
      // audited controllers.
      accountId: user.accountId!,
      nombre: user.nombre?.trim() || user.email,
    });
  }

  /**
   * Polled while `POST /importar` is in flight — null once nothing is
   * running (either it finished, or nothing was ever started). See
   * `ProgresoImportacionService`. Same gate as the import it reports on, so
   * whoever may start it may watch it and nobody else can.
   */
  @Get('importar/progreso')
  @CheckAbility(
    { action: 'create', subject: 'Inmueble' },
    { action: 'update', subject: 'Inmueble' },
  )
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
