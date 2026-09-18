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
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { CrearNotaCreditoDto } from './dto/crear-nota-credito.dto';
import { AplicarNotaCreditoDto } from './dto/aplicar-nota-credito.dto';
import { AnularNotaCreditoDto } from './dto/anular-nota-credito.dto';
import { ListarNotasCreditoDto } from './dto/listar-notas-credito.dto';
import type {
  DocumentoNotaCredito,
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
    private readonly presentacionDocumento: PresentacionDocumentoService,
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
   * This note's own frozen react-pdf presentation tree, for the browser to
   * render — same idea as `Factura.documentDefinition`. Frozen first by
   * `crear()` (every Nota Crédito applies immediately against its anchor,
   * design §5), then refrozen by `aplicar()` whenever a later deferred
   * cruce changes `montoSinAplicar`/the applied breakdown (see
   * `NotasCreditoService.congelarPresentacion`'s own docblock).
   *
   * A `null` `documentDefinition` should not normally happen in practice —
   * `crear()` always freezes one — but this stays defensive rather than
   * throwing, same as `Factura`'s equivalent route: the frontend already
   * treats `documentDefinition: null` as "not available".
   *
   * Route renamed from `.../pdf` — no PDF is built here anymore, the
   * browser renders this client-side. Lost in the move: `?duplicado=true`
   * used to stamp a "DUPLICADO" watermark dynamically on every request; a
   * frozen `documentDefinition` has no room for that anymore (the exact
   * same loss already accepted for Factura) — reprinting a duplicate copy
   * is now a client-side concern, not something this route does
   * server-side.
   */
  @Get(':id/documento')
  @CheckAbility({ action: 'read', subject: 'NotaCredito' })
  async obtenerDocumento(
    @Param('id') id: string,
  ): Promise<DocumentoNotaCredito> {
    const nota = await this.notasCredito.findOneRaw(id);
    const documentDefinition = await this.presentacionDocumento.buscar(
      'NC',
      nota._id,
    );
    return {
      documentDefinition:
        documentDefinition as DocumentoNotaCredito['documentDefinition'],
    };
  }
}
