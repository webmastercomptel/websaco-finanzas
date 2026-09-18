import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LoteRecibosService } from './lote-recibos.service';
import { CrearLoteRecibosDto } from './dto/crear-lote-recibos.dto';
import { CargarFilasLoteRecibosDto } from './dto/cargar-filas-lote-recibos.dto';
import type {
  DocumentoReciboLote,
  LoteRecibos,
  ErrorAplicacionLoteRecibos,
} from '../../contracts';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';

/** `subject: 'Recibo'` throughout — a Recibos-por-lote batch never touches
 *  cartera on its own, every row becomes a real Recibo through
 *  `RecibosService.crear()` unchanged, so it is gated by exactly the same
 *  permission a single Recibo already requires. */
@Controller('lotes-recibos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class LoteRecibosController {
  constructor(
    private readonly loteRecibos: LoteRecibosService,
    private readonly presentacionDocumento: PresentacionDocumentoService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findAll(): Promise<LoteRecibos[]> {
    return this.loteRecibos.findAll();
  }

  @Get(':id')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  findOne(@Param('id') id: string): Promise<LoteRecibos> {
    return this.loteRecibos.findOne(id);
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  crear(
    @CurrentUser() user: IRequestUser,
    @Body() dto: CrearLoteRecibosDto,
  ): Promise<LoteRecibos> {
    return this.loteRecibos.crear(user.accountId!, dto);
  }

  @Post(':id/cargar')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  cargar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
    @Body() dto: CargarFilasLoteRecibosDto,
  ): Promise<LoteRecibos> {
    return this.loteRecibos.cargarArchivo(id, user.accountId!, dto);
  }

  @Post(':id/cancelar')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  async cancelar(@Param('id') id: string): Promise<{ ok: true }> {
    await this.loteRecibos.cancelar(id);
    return { ok: true };
  }

  @Post(':id/aplicar')
  @CheckAbility({ action: 'manage', subject: 'Recibo' })
  aplicar(
    @CurrentUser() user: IRequestUser,
    @Param('id') id: string,
  ): Promise<{ lote: LoteRecibos; errores: ErrorAplicacionLoteRecibos[] }> {
    return this.loteRecibos.aplicar(id, user.accountId!);
  }

  /**
   * Every Recibo this batch's `aplicar()` produced, as its own frozen
   * `documentDefinition` — one entry per row with a real Recibo, in the
   * exact layout `GET /recibos/:id` already shows for one at a time (both
   * read the same `presentacion_documento` row, frozen once by
   * `RecibosService.congelarPresentacionRecibo`, called from inside
   * `crear()` — see that method's own docblock). No PDF is built here
   * anymore — the browser renders each entry client-side — so there's
   * nothing left to stream.
   *
   * Route renamed from `:id/pdf` — same conversion as
   * `LotesController.obtenerDocumentosFacturas`'s own `:id/facturas.pdf` ->
   * `:id/facturas/documentos` rename.
   */
  @Get(':id/recibos/documentos')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  async obtenerDocumentos(
    @Param('id') id: string,
  ): Promise<DocumentoReciboLote[]> {
    const lote = await this.loteRecibos.findOne(id);

    const reciboIds = lote.filas
      .map((f) => f.reciboId)
      .filter((rid): rid is string => rid !== null);
    if (reciboIds.length === 0) {
      throw new NotFoundException(
        `El lote de recibos ${id} todavía no tiene recibos generados`,
      );
    }

    const documentDefinitions = await this.presentacionDocumento.buscarVarios(
      'RC',
      reciboIds.map((rid) => new Types.ObjectId(rid)),
    );

    return reciboIds.map((rid) => ({
      id: rid,
      // Opaque blob, passed through unchanged — same cast
      // `LotesController.obtenerDocumentosFacturas` uses for the same field.
      documentDefinition: (documentDefinitions.get(rid) ??
        null) as DocumentoReciboLote['documentDefinition'],
    }));
  }
}
