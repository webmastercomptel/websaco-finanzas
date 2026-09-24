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
import { NotasCreditoService } from './notas-credito.service';
import {
  GeneracionDocumentoService,
  type SolicitudGeneracionDocumento,
} from '../../common/documentos/generacion-documento.service';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';
import { AplicarNotaCreditoDto } from './dto/aplicar-nota-credito.dto';
import { AnularNotaCreditoDto } from './dto/anular-nota-credito.dto';
import { ListarNotasCreditoDto } from './dto/listar-notas-credito.dto';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';
import type {
  NotaCredito,
  NotaCreditoDetalle,
  Paginado,
  ResultadoAplicacion,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'NotaCredito'` throughout, `create`/`read`/`update`/`annul` per
 * action (design §5) — CASL's `NotaCredito` subject and `notas-credito`
 * module key are already registered (verified in Task 3); no CASL code
 * changes are needed for this module. GET routes land in Task 9, `/aplicar`
 * in Task 7, `/anular` in Task 8.
 */
@Controller('notas-credito')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class NotasCreditoController {
  constructor(
    private readonly notasCredito: NotasCreditoService,
    private readonly generacion: GeneracionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  findAll(
    @Query() query: ListarNotasCreditoDto,
  ): Promise<Paginado<NotaCredito>> {
    return this.notasCredito.findAll(query);
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  findOne(@Param('id') id: string): Promise<NotaCreditoDetalle> {
    return this.notasCredito.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'NotaCredito' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearNotaCreditoDto,
  ): Promise<NotaCredito> {
    // PoliciesGuard already required a NotaCredito/create permission, which
    // only an account with an active assignment can hold — accountId is
    // guaranteed set here, same reasoning as RecibosController.crear().
    return this.notasCredito.crear(user.accountId!, dto);
  }

  @Post(':id/aplicar')
  @CheckAbility({ action: 'update', subject: 'NotaCredito' })
  aplicar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AplicarNotaCreditoDto,
  ): Promise<ResultadoAplicacion> {
    return this.notasCredito.aplicar(id, dto, user.accountId!);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'NotaCredito' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularNotaCreditoDto,
  ): Promise<NotaCredito> {
    return this.notasCredito.anular(id, dto, user.accountId!);
  }

  /**
   * Requests generation of this Nota Crédito's PDF — the template for `NC`
   * plus this note's own computed `datos`
   * (`NotasCreditoService.datosImpresion`, reusing
   * `construirDatosImpresionNotaCredito` unchanged) and an upload target.
   * Same `create` action as `crear()` above — under the new model nothing
   * re-renders after issuance (no re-freeze on `aplicar()` any more), so
   * this is the only place a Nota Crédito's document is ever generated.
   */
  @Post(':id/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'NotaCredito' })
  async solicitarGeneracion(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionDocumento<DatosReciboImpresion>> {
    const [nota, datos] = await Promise.all([
      this.notasCredito.findOneRaw(id),
      this.notasCredito.datosImpresion(id),
    ]);
    return this.generacion.solicitar('NC', nota, datos);
  }

  /**
   * Confirms the frontend finished uploading the PDF `solicitar-generacion`
   * handed it a signed URL for. Same `create` action as `crear()`/
   * `solicitar-generacion` above.
   */
  @Post(':id/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'NotaCredito' })
  async confirmarGeneracion(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const nota = await this.notasCredito.findOneRaw(id);
    return this.generacion.confirmar('NC', nota, dto.objectPath);
  }

  /**
   * This Nota Crédito's already-computed print data, always fresh — unlike
   * `solicitar-generacion`, this never orchestrates an upload and never
   * 409s when a PDF already exists. Exists for the platform's own
   * template-preview tool (`/plantilla-preview`, frontend). Same `read`
   * action as `findOne` above.
   */
  @Get(':id/datos-impresion')
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  datosImpresion(@Param('id') id: string): Promise<DatosReciboImpresion> {
    return this.notasCredito.datosImpresion(id);
  }

  /**
   * A short-lived signed URL to read back this Nota Crédito's
   * already-generated PDF. Same `read` action as `findOne` above.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const nota = await this.notasCredito.findOne(id);
    return this.generacion.urlLectura('La nota crédito', id, nota);
  }
}
