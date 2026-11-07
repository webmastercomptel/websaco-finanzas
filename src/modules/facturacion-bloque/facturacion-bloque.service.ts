// src/modules/facturacion-bloque/facturacion-bloque.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  BloqueFacturacion as BloqueContrato,
  BloqueFacturacionDetalle,
  DescargaArchivo,
  EntregaBloque,
  SubidaBloqueIniciada,
} from '../../contracts';
import {
  BloqueFacturacion,
  type BloqueFacturacionDocument,
} from '../../database/schemas/administracion/bloque-facturacion.schema';
import {
  DocumentoBloque,
  type DocumentoBloqueDocument,
} from '../../database/schemas/administracion/documento-bloque.schema';
import type { ListarBloquesDto } from './dto/listar-bloques.dto';
import type { CrearBloqueDto } from './dto/guardar-bloque.dto';
import {
  FacturacionBloqueAlmacenService,
  prefijoDeBloque,
  rutaOriginal,
} from './facturacion-bloque-almacen.service';
import {
  TAMANO_MAXIMO_BLOQUE_BYTES,
  VIGENCIA_PROCESAMIENTO_MS,
} from './facturacion-bloque-ingesta.service';
import { toBloque, toUnidadBloque } from './facturacion-bloque.mapper';

/** Staff lists are bounded: nobody reviews more than this many blocks at once. */
const MAXIMO_EN_LISTADO = 500;

/**
 * Staff side of the blocks except ingest and send (their own services): declare
 * an upload, list, detail, hand out the original, delete.
 *
 * No bytes ever pass through this API: the browser PUTs the PDF to a signed URL,
 * and staff download the original the same way (the previous system streamed up
 * to 200 MB through the process).
 */
@Injectable()
export class FacturacionBloqueService {
  private readonly logger = new Logger(FacturacionBloqueService.name);

  constructor(
    @InjectModel(BloqueFacturacion.name)
    private readonly bloques: Model<BloqueFacturacionDocument>,
    @InjectModel(DocumentoBloque.name)
    private readonly documentos: Model<DocumentoBloqueDocument>,
    private readonly tenant: TenantContextService,
    private readonly almacen: FacturacionBloqueAlmacenService,
  ) {}

  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Bloque ${id} no encontrado`);
    }
  }

  private async obtener(
    id: string,
    copropiedadId: Types.ObjectId,
  ): Promise<BloqueFacturacionDocument> {
    this.validarId(id);
    const bloque = await this.bloques
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!bloque) throw new NotFoundException(`Bloque ${id} no encontrado`);
    return bloque;
  }

  /**
   * Step 1: registers the block as `pendiente` (the backend picks the storage
   * path) and signs a write URL pinned to `application/pdf`. The uploader's name
   * is frozen from the caller's account, never taken from the body.
   */
  async crear(
    dto: CrearBloqueDto,
    user: IRequestUser,
  ): Promise<SubidaBloqueIniciada> {
    if (dto.tamanoBytes > TAMANO_MAXIMO_BLOQUE_BYTES) {
      throw new BadRequestException('El archivo supera el límite de 200 MB');
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    // The id is chosen first because the storage path is built from it.
    const _id = new Types.ObjectId();
    const ruta = rutaOriginal(copropiedadId.toString(), _id.toString());

    const creado = await new this.bloques({
      _id,
      copropiedadId,
      tipo: dto.tipo,
      periodo: dto.periodo,
      nombre: dto.nombre,
      rutaOriginal: ruta,
      tamanoBytes: dto.tamanoBytes,
      estado: 'pendiente',
      subidoPorId:
        user.accountId && Types.ObjectId.isValid(user.accountId)
          ? new Types.ObjectId(user.accountId)
          : null,
      subidoPorNombre: user.nombre ?? '',
    }).save();

    const uploadUrl = await this.almacen.firmarSubida(ruta);
    return { bloque: toBloque(creado), uploadUrl };
  }

  /** The blocks of the active coproperty, newest first. */
  async listar(filtros: ListarBloquesDto): Promise<BloqueContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documentos = await this.bloques
      .find({
        copropiedadId,
        ...(filtros.tipo && { tipo: filtros.tipo }),
        ...(filtros.estado && { estado: filtros.estado }),
      })
      .sort({ createdAt: -1 })
      .limit(MAXIMO_EN_LISTADO)
      .exec();
    return documentos.map((d) => toBloque(d));
  }

  /** One block with a row per unit and how far its delivery got. */
  async detalle(id: string): Promise<BloqueFacturacionDetalle> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const bloque = await this.obtener(id, copropiedadId);
    const unidades = await this.documentos
      .find({ copropiedadId, bloqueId: bloque._id })
      .sort({ codigoInmueble: 1 })
      .exec();
    const entrega: EntregaBloque = {
      destinatarios: bloque.destinatariosTotal,
      notificados: unidades.reduce((n, d) => n + d.notificadosIds.length, 0),
      correosEnviados: unidades.reduce(
        (n, d) => n + d.correosEnviadosIds.length,
        0,
      ),
      correoConfigurado: bloque.correoConfigurado,
    };
    return {
      ...toBloque(bloque, entrega),
      unidades: unidades.map(toUnidadBloque),
    };
  }

  /**
   * Signed URL of the ORIGINAL block (every unit's pages). Staff only; a resident
   * never gets a URL to it, only to their own unit's file.
   */
  async descargarOriginal(id: string): Promise<DescargaArchivo> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const bloque = await this.obtener(id, copropiedadId);
    if (bloque.estado === 'pendiente') {
      throw new ConflictException('El bloque todavía no tiene archivo');
    }
    const url = await this.almacen.firmarLectura(
      bloque.rutaOriginal,
      bloque.nombre,
    );
    return { url, nombre: bloque.nombre };
  }

  /**
   * Deletes a block that has NOT left the building: its record, its per-unit
   * rows and its Storage folder. Once the send started (`pendiente_envio`,
   * `enviado`) residents hold links and notices to it, so it is kept: removing
   * something already delivered is exactly what the audit law forbids for
   * billing documents. A block being processed right now is also refused.
   *
   * The state guard lives INSIDE the delete filter, so a send or an ingest that
   * claims the block between the check and the delete wins instead of losing its
   * data. Record first, then Storage: an object left behind is only an orphan,
   * a record without its object would be a broken download.
   */
  async eliminar(id: string): Promise<{ id: string }> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const bloque = await this.obtener(id, copropiedadId);
    const limite = new Date(Date.now() - VIGENCIA_PROCESAMIENTO_MS);

    const borrado = await this.bloques
      .deleteOne({
        _id: bloque._id,
        copropiedadId,
        $or: [
          { estado: { $in: ['pendiente', 'generado', 'error'] } },
          {
            estado: 'procesando',
            $or: [
              { procesamientoIniciadoEn: null },
              { procesamientoIniciadoEn: { $lt: limite } },
            ],
          },
        ],
      })
      .exec();
    if (borrado.deletedCount !== 1) {
      throw new ConflictException(
        'No se puede eliminar un bloque que se está procesando o que ya se envió a los residentes.',
      );
    }

    await this.documentos
      .deleteMany({ copropiedadId, bloqueId: bloque._id })
      .exec();
    try {
      await this.almacen.eliminarPrefijo(
        prefijoDeBloque(copropiedadId.toString(), bloque._id.toString()),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Se eliminó el bloque ${id} pero no se pudo limpiar su carpeta de Storage: ${(error as Error).message}`,
      );
    }
    return { id };
  }
}
