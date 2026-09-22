import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotasAnticipoService } from './notas-anticipo.service';
import { CrearNotaAnticipoDto } from './dto/crear-nota-anticipo.dto';
import { AnularNotaAnticipoDto } from './dto/anular-nota-anticipo.dto';
import { ListarNotaAnticipoDto } from './dto/listar-nota-anticipo.dto';
import {
  GeneracionDocumentoService,
  type SolicitudGeneracionDocumento,
} from '../../common/documentos/generacion-documento.service';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';
import type {
  NotaAnticipo,
  NotaAnticipoDetalle,
  Paginado,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'NotaAnticipo'` — its own CASL subject (module key
 * `notas-anticipo`), separate from `OtraNota` (Notas Débito): applying an
 * existing anticipo and creating a new debit charge are different enough
 * responsibilities that a role should be able to hold one without the
 * other. Actions: create, read, annul — no update, same reasoning as every
 * other financial document (immutable except for voiding).
 */
@Controller('notas-anticipo')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasAnticipoController {
  constructor(
    private readonly notasAnticipo: NotasAnticipoService,
    private readonly generacion: GeneracionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  findAll(
    @Query() query: ListarNotaAnticipoDto,
  ): Promise<Paginado<NotaAnticipo>> {
    return this.notasAnticipo.findAll(query);
  }

  /**
   * `NotaAnticipo.objectPath`/`generatedAt` (set/confirmed via
   * `solicitar-generacion`/`confirmar-generacion` below) are just fields on
   * the same mapped contract — no PDF is built or streamed by this backend.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  findOne(@Param('id') id: string): Promise<NotaAnticipoDetalle> {
    return this.notasAnticipo.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaAnticipo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaAnticipoDto,
  ): Promise<NotaAnticipo> {
    return this.notasAnticipo.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'NotaAnticipo' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaAnticipoDto,
  ): Promise<NotaAnticipo> {
    return this.notasAnticipo.anular(id, dto, user.accountId!);
  }

  /**
   * Requests generation of this Nota de Anticipo's PDF — the template for
   * `NA` plus this note's own computed `datos`
   * (`NotasAnticipoService.datosImpresion`, reusing
   * `construirDatosImpresionNotaAnticipo` unchanged) and an upload target.
   * Same `create` action as `crear()` above.
   */
  @Post(':id/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'NotaAnticipo' })
  async solicitarGeneracion(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionDocumento<DatosReciboImpresion>> {
    const [nota, datos] = await Promise.all([
      this.notasAnticipo.findOneRaw(id),
      this.notasAnticipo.datosImpresion(id),
    ]);
    return this.generacion.solicitar('NA', nota, datos);
  }

  /**
   * Confirms the frontend finished uploading the PDF `solicitar-generacion`
   * handed it a signed URL for. Same `create` action as `crear()`/
   * `solicitar-generacion` above.
   */
  @Post(':id/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'NotaAnticipo' })
  async confirmarGeneracion(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const nota = await this.notasAnticipo.findOneRaw(id);
    return this.generacion.confirmar('NA', nota, dto.objectPath);
  }

  /**
   * A short-lived signed URL to read back this Nota de Anticipo's
   * already-generated PDF. Same `read` action as `findOne` above.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'NotaAnticipo' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const nota = await this.notasAnticipo.findOne(id);
    return this.generacion.urlLectura('La nota de anticipo', id, nota);
  }
}
