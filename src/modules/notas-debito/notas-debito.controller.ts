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
import { NotasDebitoService } from './notas-debito.service';
import { CrearNotaDebitoDto } from './dto/crear-nota-debito.dto';
import { AnularNotaDebitoDto } from './dto/anular-nota-debito.dto';
import { ListarNotaDebitoDto } from './dto/listar-nota-debito.dto';
import {
  GeneracionDocumentoService,
  type SolicitudGeneracionDocumento,
} from '../../common/documentos/generacion-documento.service';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';
import type { NotaDebito, NotaDebitoDetalle, Paginado } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'OtraNota'` throughout — already registered in
 * casl-ability.constants.ts and permission-map.ts (module key:
 * 'otras-notas'). Actions: create, read, annul. No update: a Nota
 * Débito is immutable except for voiding.
 */
@Controller('notas-debito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasDebitoController {
  constructor(
    private readonly notasDebito: NotasDebitoService,
    private readonly generacion: GeneracionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  findAll(@Query() query: ListarNotaDebitoDto): Promise<Paginado<NotaDebito>> {
    return this.notasDebito.findAll(query);
  }

  /**
   * `NotaDebito.objectPath`/`generatedAt` (set/confirmed via
   * `solicitar-generacion`/`confirmar-generacion` below) are just fields on
   * the same mapped contract — no PDF is built or streamed by this backend.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  findOne(@Param('id') id: string): Promise<NotaDebitoDetalle> {
    return this.notasDebito.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'OtraNota' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaDebitoDto,
  ): Promise<NotaDebito> {
    return this.notasDebito.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'OtraNota' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaDebitoDto,
  ): Promise<NotaDebito> {
    return this.notasDebito.anular(id, dto, user.accountId!);
  }

  /**
   * Requests generation of this Nota Débito's PDF — the template for `ND`
   * plus this note's own computed `datos`
   * (`NotasDebitoService.datosImpresion`, reusing
   * `construirDatosImpresionNotaDebito` unchanged) and an upload target.
   * Same `create` action as `crear()` above.
   */
  @Post(':id/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'OtraNota' })
  async solicitarGeneracion(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionDocumento<DatosReciboImpresion>> {
    const [nota, datos] = await Promise.all([
      this.notasDebito.findOneRaw(id),
      this.notasDebito.datosImpresion(id),
    ]);
    return this.generacion.solicitar('ND', nota, datos);
  }

  /**
   * Confirms the frontend finished uploading the PDF `solicitar-generacion`
   * handed it a signed URL for. Same `create` action as `crear()`/
   * `solicitar-generacion` above.
   */
  @Post(':id/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'OtraNota' })
  async confirmarGeneracion(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const nota = await this.notasDebito.findOneRaw(id);
    return this.generacion.confirmar('ND', nota, dto.objectPath);
  }

  /**
   * This Nota Débito's already-computed print data, always fresh — unlike
   * `solicitar-generacion`, this never orchestrates an upload and never
   * 409s when a PDF already exists. Exists for the platform's own
   * template-preview tool (`/plantilla-preview`, frontend). Same `read`
   * action as `findOne` above.
   */
  @Get(':id/datos-impresion')
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  datosImpresion(@Param('id') id: string): Promise<DatosReciboImpresion> {
    return this.notasDebito.datosImpresion(id);
  }

  /**
   * A short-lived signed URL to read back this Nota Débito's
   * already-generated PDF. Same `read` action as `findOne` above.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'OtraNota' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const nota = await this.notasDebito.findOne(id);
    return this.generacion.urlLectura('La nota débito', id, nota);
  }
}
