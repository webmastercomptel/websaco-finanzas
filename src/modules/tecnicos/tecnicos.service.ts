import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { Tecnico as TecnicoContrato } from '../../contracts';
import {
  Pqr,
  type EstadoPqr,
  type PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import {
  Tecnico,
  type TecnicoDocument,
} from '../../database/schemas/administracion/tecnico.schema';
import type { ActualizarTecnicoDto } from './dto/actualizar-tecnico.dto';
import type { CrearTecnicoDto } from './dto/guardar-tecnico.dto';
import { toTecnico } from './tecnicos.mapper';

/** PQR states in which a technician has nothing left to do. */
const ESTADOS_PQR_TERMINADOS: EstadoPqr[] = ['resuelto', 'cerrado'];

/**
 * Technicians (external providers) of the ACTIVE coproperty. The tenant always
 * comes from the request context; every lookup and write filters by id AND
 * `copropiedadId`, so a technician id of another building is a plain 404.
 */
@Injectable()
export class TecnicosService {
  constructor(
    @InjectModel(Tecnico.name)
    private readonly tecnicos: Model<TecnicoDocument>,
    @InjectModel(Pqr.name)
    private readonly pqrs: Model<PqrDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Técnico ${id} no encontrado`);
    }
  }

  /** The active coproperty's technicians, by name. */
  async listar(): Promise<TecnicoContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documentos = await this.tecnicos
      .find({ copropiedadId })
      .sort({ nombre: 1 })
      .exec();
    return documentos.map(toTecnico);
  }

  /** Creates a technician in the active coproperty. */
  async crear(dto: CrearTecnicoDto): Promise<TecnicoContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const creado = await new this.tecnicos({
      copropiedadId,
      nombre: dto.nombre,
      especialidad: dto.especialidad ?? '',
      email: dto.email ?? '',
    }).save();
    return toTecnico(creado);
  }

  /** Edits a technician of the active coproperty; only the fields sent are written. */
  async actualizar(
    id: string,
    dto: ActualizarTecnicoDto,
  ): Promise<TecnicoContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cambios: Record<string, string> = {};
    if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
    if (dto.especialidad !== undefined) {
      cambios.especialidad = dto.especialidad;
    }
    if (dto.email !== undefined) cambios.email = dto.email;

    const documento =
      Object.keys(cambios).length === 0
        ? await this.tecnicos.findOne({ _id: id, copropiedadId }).exec()
        : await this.tecnicos
            .findOneAndUpdate(
              { _id: id, copropiedadId },
              { $set: cambios },
              { new: true },
            )
            .exec();
    if (!documento) throw new NotFoundException(`Técnico ${id} no encontrado`);
    return toTecnico(documento);
  }

  /**
   * Deletes a technician of the active coproperty. Refuses (409) while it still
   * has PQRs assigned that are not resolved/closed: deleting it would leave open
   * work pointing at nobody. A PQR that is already finished keeps its stale
   * reference harmlessly (it reads as "unassigned").
   */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pqrsActivas = await this.pqrs
      .countDocuments({
        copropiedadId,
        tecnicoId: new Types.ObjectId(id),
        estado: { $nin: ESTADOS_PQR_TERMINADOS },
      })
      .exec();
    if (pqrsActivas > 0) {
      throw new ConflictException(
        'No se puede eliminar un técnico con PQRs activas asignadas',
      );
    }

    const documento = await this.tecnicos
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento) throw new NotFoundException(`Técnico ${id} no encontrado`);
    return { id };
  }
}
