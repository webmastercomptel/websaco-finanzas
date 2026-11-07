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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type {
  DescargaArchivo,
  Pqr,
  PqrAdjuntoSubidaIniciada,
} from '../../contracts';
import { Modulo } from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { CrearAdjuntoPqrDto } from './dto/guardar-adjunto.dto';
import { CrearPqrPortalDto } from './dto/guardar-pqr-portal.dto';
import { CrearSeguimientoDto } from './dto/guardar-seguimiento.dto';
import { ListarPqrDto } from './dto/listar-pqr.dto';
import { PqrAdjuntosService } from './pqr-adjuntos.service';
import { PqrService } from './pqr.service';

/**
 * Resident side of the PQRs: file one from a unit they hold, list and open the
 * ones they filed, reply on them and attach evidence. Guarded by `PortalGuard`
 * (the caller must hold a unit of the ACTIVE coproperty, which must have
 * contracted the module) and deliberately NOT by CASL: residents carry no
 * permissions, and putting these routes behind `PoliciesGuard` would lock out
 * exactly the people they are for.
 *
 * Authorization is data-level instead: every handler reaches the service through
 * a `...Propia` / `...Residente` method that narrows the query to PQRs the caller
 * filed, so somebody else's PQR is a 404. There is no status, assignment or
 * "all PQRs" route here and must not be one.
 */
@Controller('portal/pqr')
@UseGuards(FirebaseAuthGuard, PortalGuard)
@Modulo('administracion')
export class PqrPortalController {
  constructor(
    private readonly pqr: PqrService,
    private readonly adjuntos: PqrAdjuntosService,
  ) {}

  @Post()
  crear(
    @Body() dto: CrearPqrPortalDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr> {
    return this.pqr.crearComoResidente(dto, user);
  }

  @Get()
  listar(
    @Query() filtros: ListarPqrDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr[]> {
    return this.pqr.listarPropias(filtros, user);
  }

  @Get(':id')
  obtener(
    @Param('id') id: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr> {
    return this.pqr.obtenerPropia(id, user);
  }

  @Post(':id/seguimientos')
  responder(
    @Param('id') id: string,
    @Body() dto: CrearSeguimientoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr> {
    return this.pqr.responderPropia(id, dto, user);
  }

  @Post(':id/adjuntos')
  iniciarAdjunto(
    @Param('id') id: string,
    @Body() dto: CrearAdjuntoPqrDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<PqrAdjuntoSubidaIniciada> {
    return this.adjuntos.iniciarSubidaResidente(id, dto, user);
  }

  @Patch(':id/adjuntos/:attachmentId/confirmar')
  confirmarAdjunto(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr> {
    return this.adjuntos.confirmarSubidaResidente(id, attachmentId, user);
  }

  /** Short-lived signed read URL of one verified attachment of an own PQR. */
  @Get(':id/adjuntos/:attachmentId/descargar')
  descargarAdjunto(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: IRequestUser,
  ): Promise<DescargaArchivo> {
    return this.adjuntos.descargarAdjuntoResidente(id, attachmentId, user);
  }
}
