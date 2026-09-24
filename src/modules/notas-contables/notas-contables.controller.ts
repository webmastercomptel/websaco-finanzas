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
import { NotasContablesService } from './notas-contables.service';
import { CrearNotaContableDto } from './dto/crear-nota-contable.dto';
import { AnularNotaContableDto } from './dto/anular-nota-contable.dto';
import { ListarNotaContableDto } from './dto/listar-nota-contable.dto';
import {
  GeneracionDocumentoService,
  type SolicitudGeneracionDocumento,
} from '../../common/documentos/generacion-documento.service';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';
import type { NotaContable, Paginado } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

@Controller('notas-contables')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasContablesController {
  constructor(
    private readonly notasContables: NotasContablesService,
    private readonly generacion: GeneracionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  findAll(
    @Query() query: ListarNotaContableDto,
  ): Promise<Paginado<NotaContable>> {
    return this.notasContables.findAll(query);
  }

  /**
   * `NotaContable.objectPath`/`generatedAt` (set/confirmed via
   * `solicitar-generacion`/`confirmar-generacion` below) are just fields on
   * the same mapped contract — no PDF is built or streamed by this backend.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  findOne(@Param('id') id: string): Promise<NotaContable> {
    return this.notasContables.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaContable' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaContableDto,
  ): Promise<NotaContable> {
    return this.notasContables.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'NotaContable' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaContableDto,
  ): Promise<NotaContable> {
    return this.notasContables.anular(id, dto, user.accountId!);
  }

  /**
   * Requests generation of this Nota Contable's PDF — the template for
   * `NT` plus this note's own computed `datos`
   * (`NotasContablesService.datosImpresion`, reusing
   * `construirDatosImpresionNotaContable` unchanged) and an upload target.
   * Same `create` action as `crear()` above.
   */
  @Post(':id/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'NotaContable' })
  async solicitarGeneracion(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionDocumento<DatosReciboImpresion>> {
    const [nota, datos] = await Promise.all([
      this.notasContables.findOneRaw(id),
      this.notasContables.datosImpresion(id),
    ]);
    return this.generacion.solicitar('NT', nota, datos);
  }

  /**
   * Confirms the frontend finished uploading the PDF `solicitar-generacion`
   * handed it a signed URL for. Same `create` action as `crear()`/
   * `solicitar-generacion` above.
   */
  @Post(':id/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'NotaContable' })
  async confirmarGeneracion(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const nota = await this.notasContables.findOneRaw(id);
    return this.generacion.confirmar('NT', nota, dto.objectPath);
  }

  /**
   * This Nota Contable's already-computed print data, always fresh —
   * unlike `solicitar-generacion`, this never orchestrates an upload and
   * never 409s when a PDF already exists. Exists for the platform's own
   * template-preview tool (`/plantilla-preview`, frontend). Same `read`
   * action as `findOne` above.
   */
  @Get(':id/datos-impresion')
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  datosImpresion(@Param('id') id: string): Promise<DatosReciboImpresion> {
    return this.notasContables.datosImpresion(id);
  }

  /**
   * A short-lived signed URL to read back this Nota Contable's
   * already-generated PDF. Same `read` action as `findOne` above.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'NotaContable' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const nota = await this.notasContables.findOne(id);
    return this.generacion.urlLectura('La nota contable', id, nota);
  }
}
