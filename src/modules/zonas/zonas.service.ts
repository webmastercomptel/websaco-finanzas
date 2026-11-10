// src/modules/zonas/zonas.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { siguienteCodigo } from '../../common/consecutivos/codigo-consecutivo';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { relojDeParedBogota } from '../../common/utils/reloj-bogota';
import type { Espacio, ZonaComun } from '../../contracts';
import {
  ConsecutivoAdministracion,
  type ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  ESTADOS_RESERVA_ACTIVOS,
  Reserva,
  type ReservaDocument,
} from '../../database/schemas/administracion/reserva.schema';
import {
  Zona,
  type ZonaDocument,
} from '../../database/schemas/administracion/zona.schema';
import type { ActualizarZonaDto } from './dto/actualizar-zona.dto';
import type { CrearZonaDto } from './dto/guardar-zona.dto';
import type { ListarEspaciosDto } from './dto/listar-espacios.dto';
import type { ListarZonasDto } from './dto/listar-zonas.dto';
import { ZonasImagenService } from './zonas-imagen.service';
import {
  desdeActualizarDto,
  desdeCrearDto,
  toEspacio,
  toZonaComun,
} from './zonas.mapper';

/**
 * Common areas of the ACTIVE coproperty. The tenant always comes from the
 * request context; every lookup and write filters by id AND `copropiedadId`, so
 * a zone id of another building is a plain 404.
 *
 * Staff manage zones (`ZonasController`, CASL) and residents only list the
 * bookable ones (`ZonasPortalController`, `PortalGuard`); both use this service.
 */
@Injectable()
export class ZonasService {
  constructor(
    @InjectModel(Zona.name)
    private readonly zonas: Model<ZonaDocument>,
    @InjectModel(Reserva.name)
    private readonly reservas: Model<ReservaDocument>,
    @InjectModel(ConsecutivoAdministracion.name)
    private readonly consecutivos: Model<ConsecutivoAdministracionDocument>,
    private readonly tenant: TenantContextService,
    private readonly imagenes: ZonasImagenService,
  ) {}

  /** Signed read URL of an uploaded image, or null (the mapper falls back). */
  private async imagenDe(doc: ZonaDocument): Promise<string | null> {
    return doc.imagenRuta ? this.imagenes.urlLectura(doc.imagenRuta) : null;
  }

  private async aZonaComun(doc: ZonaDocument): Promise<ZonaComun> {
    return toZonaComun(doc, await this.imagenDe(doc));
  }

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Zona común ${id} no encontrada`);
    }
  }

  /** Creates a zone in the active coproperty with the next `ZC-001` code. */
  async crear(dto: CrearZonaDto): Promise<ZonaComun> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const codigo = await siguienteCodigo(this.consecutivos, 'ZC');
    const creada = await new this.zonas({
      ...desdeCrearDto(dto, copropiedadId),
      codigo,
    }).save();
    return this.aZonaComun(creada);
  }

  /** The active coproperty's zones by code, optionally filtered. */
  async listar(filtros: ListarZonasDto): Promise<ZonaComun[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    if (filtros.tipo && filtros.tipo !== 'todos') filtro.tipo = filtros.tipo;
    if (filtros.estado && filtros.estado !== 'todos') {
      filtro.estado = filtros.estado;
    }
    const documentos = await this.zonas.find(filtro).sort({ codigo: 1 }).exec();
    return Promise.all(documentos.map((d) => this.aZonaComun(d)));
  }

  /**
   * What a resident may book: only zones flagged `requiereReserva`. `social` is
   * "everything that is not `deportiva`", as in the system this replaces.
   */
  async listarEspacios(filtros: ListarEspaciosDto): Promise<Espacio[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = {
      copropiedadId,
      requiereReserva: true,
    };
    if (filtros.categoria === 'deportes') filtro.tipo = 'deportiva';
    if (filtros.categoria === 'social') filtro.tipo = { $ne: 'deportiva' };
    const documentos = await this.zonas.find(filtro).sort({ codigo: 1 }).exec();
    return Promise.all(
      documentos.map(async (d) => toEspacio(d, await this.imagenDe(d))),
    );
  }

  /** Edits a zone of the active coproperty and returns the contract. */
  async actualizar(id: string, dto: ActualizarZonaDto): Promise<ZonaComun> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.zonas
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: desdeActualizarDto(dto) },
        { new: true },
      )
      .exec();
    if (!documento) {
      throw new NotFoundException(`Zona común ${id} no encontrada`);
    }
    return this.aZonaComun(documento);
  }

  /**
   * Deletes a zone of the active coproperty; 404 when there is none.
   *
   * It is refused (409) while the zone still has `pendiente`/`aprobada` bookings
   * that have not ended: the system this replaces deleted it anyway and left
   * those bookings pointing at nothing, holding a slot nobody could see. The
   * check is a read followed by the delete, so a booking created in between can
   * still slip through; that window is milliseconds and the staff action is
   * rare, so it is not worth a transaction.
   */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const vigentes = await this.reservas.countDocuments({
      copropiedadId,
      zonaId: new Types.ObjectId(id),
      estado: { $in: [...ESTADOS_RESERVA_ACTIVOS] },
      // Bookings store the Bogotá wall clock as UTC: "not ended" on that scale.
      fin: { $gt: relojDeParedBogota() },
    });
    if (vigentes > 0) {
      throw new ConflictException(
        'La zona tiene reservas pendientes o aprobadas. Cancelalas antes de eliminarla.',
      );
    }

    const documento = await this.zonas
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento) {
      throw new NotFoundException(`Zona común ${id} no encontrada`);
    }
    return { id };
  }
}
