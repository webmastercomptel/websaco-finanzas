import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { inicioDelDiaBogota } from '../../common/utils/reloj-bogota';
import type {
  Equipo as EquipoContrato,
  HojaDeVidaEquipo,
} from '../../contracts';
import {
  Equipo,
  type EquipoDocument,
} from '../../database/schemas/administracion/equipo.schema';
import {
  Mantenimiento,
  type MantenimientoDocument,
} from '../../database/schemas/administracion/mantenimiento.schema';
import type { ActualizarEquipoDto } from './dto/actualizar-equipo.dto';
import type { CrearEquipoDto } from './dto/guardar-equipo.dto';
import type { ListarEquiposDto } from './dto/listar-equipos.dto';
import { toMantenimiento } from '../mantenimientos/mantenimientos.mapper';
import { toEquipo } from './equipos.mapper';

/**
 * Equipment catalog of the ACTIVE coproperty. The tenant always comes from the
 * request context; every lookup and write filters by id AND `copropiedadId`,
 * so an equipment id of another building is a plain 404.
 */
@Injectable()
export class EquiposService {
  constructor(
    @InjectModel(Equipo.name)
    private readonly equipos: Model<EquipoDocument>,
    @InjectModel(Mantenimiento.name)
    private readonly mantenimientos: Model<MantenimientoDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Equipo ${id} no encontrado`);
    }
  }

  /** The active coproperty's equipment, by name, optionally by state. */
  async listar(f: ListarEquiposDto): Promise<EquipoContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    if (f.estado) filtro.estado = f.estado;
    const documentos = await this.equipos
      .find(filtro)
      .sort({ nombre: 1 })
      .exec();
    return documentos.map(toEquipo);
  }

  /**
   * Looks an equipment up inside one tenant (id AND `copropiedadId`); null when
   * it is malformed, missing or of another building. Shared with the
   * maintenance module, which validates `equipoId` through it.
   */
  buscarDelTenant(
    copropiedadId: Types.ObjectId,
    id: string,
  ): Promise<EquipoDocument | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return this.equipos.findOne({ _id: id, copropiedadId }).exec();
  }

  /**
   * The equipment's life sheet: its data, a summary and its whole maintenance
   * history (newest first). Business dates are UTC-midnight days, so "upcoming"
   * compares against the start of today's Bogotá day on that same scale.
   */
  async hojaDeVida(id: string): Promise<HojaDeVidaEquipo> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const equipo = await this.buscarDelTenant(copropiedadId, id);
    if (!equipo) throw new NotFoundException(`Equipo ${id} no encontrado`);

    const documentos = await this.mantenimientos
      .find({ copropiedadId, equipoId: equipo._id })
      .sort({ fecha: -1 })
      .exec();

    const hoy = inicioDelDiaBogota().getTime();
    const referencia = (d: MantenimientoDocument) => ({
      id: d._id.toString(),
      codigo: d.codigo,
      fecha: d.fecha.toISOString(),
    });
    const completados = documentos.filter((d) => d.estado === 'completado');
    // Sorted newest first: the first completed is the latest, the LAST open
    // one dated today or later is the earliest upcoming.
    const ultimo = completados[0];
    const proximo = documentos
      .filter(
        (d) =>
          (d.estado === 'programado' || d.estado === 'en_progreso') &&
          d.fecha.getTime() >= hoy,
      )
      .at(-1);

    const nombres = new Map([[equipo._id.toString(), equipo.nombre]]);
    return {
      equipo: toEquipo(equipo),
      resumen: {
        ultimo: ultimo ? referencia(ultimo) : null,
        proximo: proximo ? referencia(proximo) : null,
        costoAcumulado: completados.reduce(
          (suma, d) => suma + (d.costoEstimado ?? 0),
          0,
        ),
        totalMantenimientos: documentos.length,
      },
      mantenimientos: documentos.map((d) => toMantenimiento(d, nombres)),
    };
  }

  /** Creates an equipment in the active coproperty. */
  async crear(dto: CrearEquipoDto): Promise<EquipoContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const creado = await new this.equipos({
      copropiedadId,
      nombre: dto.nombre,
      tipo: dto.tipo ?? '',
      ubicacion: dto.ubicacion ?? '',
      marca: dto.marca ?? '',
      modelo: dto.modelo ?? '',
      serial: dto.serial ?? '',
      fechaInstalacion: dto.fechaInstalacion
        ? new Date(dto.fechaInstalacion)
        : null,
      estado: dto.estado ?? 'operativo',
      notas: dto.notas ?? null,
    }).save();
    return toEquipo(creado);
  }

  /** Edits an equipment of the active coproperty; only the fields sent are written. */
  async actualizar(
    id: string,
    dto: ActualizarEquipoDto,
  ): Promise<EquipoContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cambios: Record<string, unknown> = {};
    for (const campo of [
      'nombre',
      'tipo',
      'ubicacion',
      'marca',
      'modelo',
      'serial',
      'estado',
    ] as const) {
      if (dto[campo] !== undefined) cambios[campo] = dto[campo];
    }
    if (dto.fechaInstalacion !== undefined) {
      cambios.fechaInstalacion = dto.fechaInstalacion
        ? new Date(dto.fechaInstalacion)
        : null;
    }
    if (dto.notas !== undefined) cambios.notas = dto.notas;

    const documento =
      Object.keys(cambios).length === 0
        ? await this.equipos.findOne({ _id: id, copropiedadId }).exec()
        : await this.equipos
            .findOneAndUpdate(
              { _id: id, copropiedadId },
              { $set: cambios },
              { new: true },
            )
            .exec();
    if (!documento) throw new NotFoundException(`Equipo ${id} no encontrado`);
    return toEquipo(documento);
  }

  /**
   * Deletes an equipment of the active coproperty. Refuses (409) while any
   * maintenance points to it, whatever its state: the hoja de vida must not
   * lose its history; the way to retire it is `dado_de_baja`.
   */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const mantenimientos = await this.mantenimientos
      .countDocuments({ copropiedadId, equipoId: new Types.ObjectId(id) })
      .exec();
    if (mantenimientos > 0) {
      throw new ConflictException(
        'Este equipo tiene mantenimientos: dalo de baja en vez de eliminarlo.',
      );
    }

    const documento = await this.equipos
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento) throw new NotFoundException(`Equipo ${id} no encontrado`);
    return { id };
  }
}
