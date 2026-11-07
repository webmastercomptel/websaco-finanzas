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
import type { Pqr, PqrAdjuntoSubidaIniciada } from '../../contracts';
import { CheckAbility, Modulo } from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { ActualizarPqrDto } from './dto/actualizar-pqr.dto';
import { CrearAdjuntoPqrDto } from './dto/guardar-adjunto.dto';
import { CrearPqrDto } from './dto/guardar-pqr.dto';
import { CrearSeguimientoDto } from './dto/guardar-seguimiento.dto';
import { ListarPqrDto } from './dto/listar-pqr.dto';
import { PqrAdjuntosService } from './pqr-adjuntos.service';
import { PqrService } from './pqr.service';

/**
 * Staff side of the PQRs: `read` (`pqr.ver`) lists and opens any PQR of the
 * coproperty; everything that changes one (register on somebody's behalf, set
 * status/priority/technician, reply, attach) needs `manage` (`pqr.gestionar`).
 * Residents never come through here: they carry no permissions and use
 * `PqrPortalController` (`/portal/pqr`), which only ever reaches their own PQRs.
 * Do not "simplify" a write route down to `read`.
 */
@Controller('pqrs')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@Modulo('administracion')
export class PqrController {
  constructor(
    private readonly pqr: PqrService,
    private readonly adjuntos: PqrAdjuntosService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Pqr' })
  listar(@Query() filtros: ListarPqrDto): Promise<Pqr[]> {
    return this.pqr.listar(filtros);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Pqr' })
  obtener(@Param('id') id: string): Promise<Pqr> {
    return this.pqr.obtener(id);
  }

  @Post()
  @CheckAbility({ action: 'manage', subject: 'Pqr' })
  crear(
    @Body() dto: CrearPqrDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr> {
    return this.pqr.crear(dto, user);
  }

  @Patch(':id')
  @CheckAbility({ action: 'manage', subject: 'Pqr' })
  actualizar(
    @Param('id') id: string,
    @Body() dto: ActualizarPqrDto,
  ): Promise<Pqr> {
    return this.pqr.actualizar(id, dto);
  }

  @Post(':id/seguimientos')
  @CheckAbility({ action: 'manage', subject: 'Pqr' })
  responder(
    @Param('id') id: string,
    @Body() dto: CrearSeguimientoDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Pqr> {
    return this.pqr.responder(id, dto, user);
  }

  @Post(':id/adjuntos')
  @CheckAbility({ action: 'manage', subject: 'Pqr' })
  iniciarAdjunto(
    @Param('id') id: string,
    @Body() dto: CrearAdjuntoPqrDto,
  ): Promise<PqrAdjuntoSubidaIniciada> {
    return this.adjuntos.iniciarSubida(id, dto);
  }

  @Patch(':id/adjuntos/:attachmentId/confirmar')
  @CheckAbility({ action: 'manage', subject: 'Pqr' })
  confirmarAdjunto(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ): Promise<Pqr> {
    return this.adjuntos.confirmarSubida(id, attachmentId);
  }
}
