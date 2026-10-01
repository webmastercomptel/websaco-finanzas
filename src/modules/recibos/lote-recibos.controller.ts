import {
  BadRequestException,
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
import { RecibosService } from './recibos.service';
import { GeneracionDocumentoService } from '../../common/documentos/generacion-documento.service';
import { ConfirmarGeneracionDocumentoDto } from '../../common/documentos/dto/confirmar-generacion-documento.dto';
import type { SolicitudGeneracionReciboLote } from '../../contracts';

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
    private readonly recibosService: RecibosService,
    private readonly generacion: GeneracionDocumentoService,
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
   * Every Recibo this batch's `aplicar()` produced, with its own
   * presentation pointer — one entry per row with a real Recibo, in the
   * exact layout `GET /recibos/:id` already shows for one at a time (both
   * read the same `presentacion_documento` row). See
   * `LotesController.obtenerDocumentosFacturas`'s identical pattern for
   * Factura.
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

    const presentaciones = await this.presentacionDocumento.buscarVarios(
      'RC',
      reciboIds.map((rid) => new Types.ObjectId(rid)),
    );

    // `lote.filas` already carries each row's own `inmuebleCodigo` (the file's
    // own código, already resolved and validated against a real Inmueble by
    // `cargarArchivo` — see `LoteRecibosService`'s own note on that field) —
    // no separate Inmueble lookup needed, same "already have it in hand"
    // reasoning as `DocumentoFacturaLote`/`DocumentoPrefacturaLote`'s own
    // frozen `unitCode`.
    const codigoPorRecibo = new Map(
      lote.filas
        .filter(
          (f): f is typeof f & { reciboId: string } => f.reciboId !== null,
        )
        .map((f) => [f.reciboId, f.inmuebleCodigo]),
    );

    return reciboIds.map((rid) => {
      const presentacion = presentaciones.get(rid);
      return {
        id: rid,
        inmuebleCodigo: codigoPorRecibo.get(rid) ?? '',
        objectPath: presentacion?.objectPath ?? null,
        generatedAt: presentacion?.generatedAt.toISOString() ?? null,
      };
    });
  }

  /**
   * `solicitar-generacion` for the lote's combined receipt PDF — ONE file
   * (one page per Recibo), anchored on the LOTE's own `_id` as
   * `documentoId`, under the SAME `'RC'` code every individual Recibo
   * already uses (every `presentacion_documento` query is scoped by the
   * exact `documentoId` in hand, never a bare tipoDocumento scan, so no
   * collision is possible). Uses the same shared
   * `GeneracionDocumentoService.solicitar` helper Factura's own lote route
   * uses (`LotesController.solicitarGeneracionFacturas`), which means this
   * combined PDF renders through the exact same already-authored `'RC'`
   * template every individual Recibo already prints from — no new template
   * to author. Each row's `datos` is
   * `RecibosService.datosImpresion(reciboId)`, called once per Recibo in
   * the lote.
   *
   * Requires `lote.status === 'aplicado'` — `aplicar()` is best-effort
   * (see `LoteRecibosService`'s own docblock), so a `cargado` lote can have
   * SOME rows with a `reciboId` and others still pending retry. Confirming
   * the combined PDF against that partial state would freeze it there
   * forever: `PresentacionDocumentoService.confirmarGeneracion` refuses a
   * second confirm for the same `(tipoDocumento, documentoId)`, so once the
   * remaining rows are later applied, there would be no way to regenerate
   * the file to include them.
   */
  @Post(':id/recibos/solicitar-generacion')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  async solicitarGeneracionRecibos(
    @Param('id') id: string,
  ): Promise<SolicitudGeneracionReciboLote> {
    const lote = await this.loteRecibos.findOneRaw(id);

    if (lote.estado !== 'aplicado') {
      throw new BadRequestException(
        `El lote de recibos ${id} todavía no está aplicado — generá el combinado recién cuando todas las filas se hayan aplicado con éxito`,
      );
    }

    const reciboIds = lote.filas
      .map((f) => f.reciboId)
      .filter((rid): rid is Types.ObjectId => rid !== null);
    if (reciboIds.length === 0) {
      throw new NotFoundException(
        `El lote de recibos ${id} todavía no tiene recibos generados`,
      );
    }

    const recibos = await Promise.all(
      reciboIds.map(async (reciboId) => ({
        reciboId: reciboId.toString(),
        datos: await this.recibosService.datosImpresion(reciboId.toString()),
      })),
    );

    const { plantilla, objectPath, uploadUrl, expiresAt } =
      await this.generacion.solicitar('RC', lote, recibos);

    return { plantilla, objectPath, uploadUrl, expiresAt, recibos };
  }

  /**
   * Confirms the frontend finished uploading the lote's combined receipt
   * PDF. Unlike Factura's equivalent, there is no per-item snapshot to
   * freeze afterward — each Recibo already keeps its own independent `'RC'`
   * presentation pointer (keyed by ITS OWN `_id`), untouched by this
   * combined file (keyed by the LOTE's `_id`) existing alongside it.
   */
  @Post(':id/recibos/confirmar-generacion')
  @CheckAbility({ action: 'create', subject: 'Recibo' })
  async confirmarGeneracionRecibos(
    @Param('id') id: string,
    @Body() dto: ConfirmarGeneracionDocumentoDto,
  ): Promise<{ objectPath: string }> {
    const lote = await this.loteRecibos.findOneRaw(id);
    return this.generacion.confirmar('RC', lote, dto.objectPath);
  }

  /**
   * A short-lived signed URL to read back this lote's combined receipt PDF
   * — never a single Recibo's own document (that stays `GET
   * /recibos/:id/documento-pdf`, unaffected by this feature).
   */
  @Get(':id/recibos-generados/url-lectura')
  @CheckAbility({ action: 'read', subject: 'Recibo' })
  async urlLecturaRecibos(
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const lote = await this.loteRecibos.findOneRaw(id);
    const presentacion = await this.presentacionDocumento.buscar(
      'RC',
      lote._id,
    );
    return this.generacion.urlLectura(
      'El lote de recibos',
      id,
      presentacion ?? { objectPath: null, generatedAt: null },
    );
  }
}
