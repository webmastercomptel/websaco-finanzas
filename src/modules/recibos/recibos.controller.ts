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
import { RecibosService } from './recibos.service';
import { CrearReciboDto } from './dto/crear-recibo.dto';
import { AnularReciboDto } from './dto/anular-recibo.dto';
import { ListarRecibosDto } from './dto/listar-recibos.dto';
import {
  GeneracionDocumentoService,
  type SolicitudGeneracionDocumento,
} from '../../common/documentos/generacion-documento.service';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import type { DatosReciboImpresion } from '../../common/documentos/datos-impresion.types';
import type { Paginado, Recibo, ReciboDetalle } from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

/**
 * `subject: 'Recibo'` throughout, `create`/`read`/`annul` per action — same
 * one-subject-for-the-whole-lifecycle choice LotesController already made
 * for `'Factura'` (design §5). There is deliberately no `/aplicar` route —
 * a Recibo left with a pending anticipo (`unappliedAmount > 0`) is applied
 * from the `notas-anticipo` module instead, never from here (see
 * `NotasAnticipoService`).
 */
@Controller('recibos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class RecibosController {
  constructor(
    private readonly recibos: RecibosService,
    private readonly generacion: GeneracionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findAll(@Query() query: ListarRecibosDto): Promise<Paginado<Recibo>> {
    return this.recibos.findAll(query);
  }

  /**
   * `Recibo.objectPath`/`generatedAt` (set/confirmed via
   * `solicitar-generacion`/`confirmar-generacion` below) are just fields on
   * the same mapped contract — no PDF is built or streamed by this backend,
   * the browser renders it client-side from `plantilla_documento` +
   * `RecibosService.datosImpresion`.
   */
  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findOne(@Param('id') id: string): Promise<ReciboDetalle> {
    return this.recibos.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearReciboDto,
  ): Promise<Recibo> {
    // PoliciesGuard already required a Recibo/create permission, which only
    // an account with an active assignment can hold — accountId is
    // guaranteed set here, same reasoning as LotesController.crear().
    return this.recibos.crear(user.accountId!, dto);
  }

  @Post(':id/anular')
  @CheckAbility({ action: 'annul', subject: 'Recibo' })
  anular(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: AnularReciboDto,
  ): Promise<Recibo> {
    // Same reasoning as crear()/aplicar() above for the non-null assertion:
    // PoliciesGuard already required a Recibo/annul permission, which only an
    // account with an active assignment can hold.
    return this.recibos.anular(id, dto, user.accountId!);
  }

  /**
   * Requests generation of this Recibo's PDF — the template for `RC` plus
   * this receipt's own computed `datos` (`RecibosService.datosImpresion`,
   * reusing `construirDatosImpresionRecibo` unchanged) and an upload target.
   * Same `create` action as `crear()` above — same capability.
   */
  @Post(':id/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  async solicitarGeneracion(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionDocumento<DatosReciboImpresion>> {
    const [recibo, datos] = await Promise.all([
      this.recibos.findOneRaw(id),
      this.recibos.datosImpresion(id),
    ]);
    return this.generacion.solicitar('RC', recibo, datos);
  }

  /**
   * Confirms the frontend finished uploading the PDF `solicitar-generacion`
   * handed it a signed URL for. Same `create` action as `crear()`/
   * `solicitar-generacion` above.
   */
  @Post(':id/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  async confirmarGeneracion(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const recibo = await this.recibos.findOneRaw(id);
    return this.generacion.confirmar('RC', recibo, dto.objectPath);
  }

  /**
   * This Recibo's already-computed print data, always fresh — unlike
   * `solicitar-generacion`, this never orchestrates an upload and never
   * 409s when a PDF already exists (that check lives inside
   * `GeneracionDocumentoService.solicitar`, never reached here). Exists for
   * the platform's own template-preview tool (`/plantilla-preview`,
   * frontend), which needs `datos` for an ALREADY-generated Recibo too —
   * `solicitar-generacion` alone can't give that, since a generated
   * document only has a signed URL to read back, not its own print data.
   * Same `read` action as `findOne` above.
   */
  @Get(':id/datos-impresion')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  datosImpresion(@Param('id') id: string): Promise<DatosReciboImpresion> {
    return this.recibos.datosImpresion(id);
  }

  /**
   * A short-lived signed URL to read back this Recibo's already-generated
   * PDF. Same `read` action as `findOne` above.
   */
  @Get(':id/url-lectura')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  async urlLectura(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const recibo = await this.recibos.findOne(id);
    return this.generacion.urlLectura('El recibo', id, recibo);
  }
}
