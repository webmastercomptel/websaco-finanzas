// src/modules/roles/roles.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { siguienteNumero } from '../../common/consecutivos/codigo-consecutivo';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  ConsecutivoAdministracion,
  ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  Rol,
  RolDocument,
} from '../../database/schemas/administracion/rol.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import type { Permiso, Rol as RolContrato } from '../../contracts';
import {
  esPermisoAdministracion,
  PERMISOS_ADMINISTRACION,
} from '../casl/permisos-catalogo';
import type { ActualizarRolDto, CrearRolDto } from './dto/guardar-rol.dto';
import { toPermiso, toRol } from './roles.mapper';

/** Mongo's duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

/**
 * Roles are bundles of Administración keys only: anything else — a Finanzas key,
 * a typo, a verb the module does not have — is refused. This is what keeps
 * whoever edits roles from widening anybody's access to the financial side.
 */
const exigirPermisosAsignables = (permisos: readonly string[] | undefined) => {
  const invalidos = (permisos ?? []).filter((p) => !esPermisoAdministracion(p));
  if (invalidos.length > 0) {
    throw new BadRequestException(
      `Permisos que un rol no puede incluir: ${invalidos.join(', ')}`,
    );
  }
};

/**
 * Roles of the ACTIVE coproperty (the tenant comes from the request context,
 * never from the payload). Every lookup filters by id AND coproperty, so a role
 * of another building is a 404, not a leak.
 */
@Injectable()
export class RolesService {
  constructor(
    @InjectModel(Rol.name) private readonly roles: Model<RolDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(ConsecutivoAdministracion.name)
    private readonly consecutivos: Model<ConsecutivoAdministracionDocument>,
    private readonly tenant: TenantContextService,
  ) {}

  /** `ROL-001`, sequenced per coproperty (the key embeds it, the code does not). */
  private async siguienteCodigoDeRol(
    copropiedadId: Types.ObjectId,
  ): Promise<string> {
    const numero = await siguienteNumero(
      this.consecutivos,
      `ROL:${copropiedadId.toString()}`,
    );
    return `ROL-${String(numero).padStart(3, '0')}`;
  }

  /** Active staff assignments of this coproperty that carry the role. */
  private contarUsuarios(
    copropiedadId: Types.ObjectId,
    rolId: Types.ObjectId | string,
  ): Promise<number> {
    return this.asignaciones
      .countDocuments({ copropiedadId, roleIds: rolId, estado: 'active' })
      .exec();
  }

  async create(dto: CrearRolDto): Promise<RolContrato> {
    exigirPermisosAsignables(dto.permisos);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const codigo = await this.siguienteCodigoDeRol(copropiedadId);
    try {
      const creado = await this.roles.create({
        copropiedadId,
        codigo,
        nombre: dto.nombre,
        descripcion: dto.descripcion ?? '',
        ...(dto.color !== undefined && { color: dto.color }),
        esPredeterminado: dto.esPredeterminado ?? false,
        permisos: dto.permisos ?? [],
      });
      return toRol(creado, 0);
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException('Ya existe un rol con ese nombre');
      }
      throw error;
    }
  }

  /** The coproperty's roles, each with how many active assignments carry it. */
  async findAll(): Promise<RolContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documentos = await this.roles
      .find({ copropiedadId })
      .sort({ codigo: 1 })
      .exec();

    const conteos = await this.asignaciones
      .aggregate<{ _id: Types.ObjectId; n: number }>([
        {
          $match: {
            copropiedadId,
            alcance: 'copropiedad',
            estado: 'active',
          },
        },
        { $unwind: '$roleIds' },
        { $group: { _id: '$roleIds', n: { $sum: 1 } } },
      ])
      .exec();
    const porRol = new Map(conteos.map((c) => [c._id.toString(), c.n]));

    return documentos.map((d) => toRol(d, porRol.get(d._id.toString()) ?? 0));
  }

  async update(id: string, dto: ActualizarRolDto): Promise<RolContrato> {
    exigirPermisosAsignables(dto.permisos);
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Rol ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cambios: Record<string, unknown> = {};
    if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
    if (dto.descripcion !== undefined) cambios.descripcion = dto.descripcion;
    if (dto.color !== undefined) cambios.color = dto.color;
    if (dto.esPredeterminado !== undefined) {
      cambios.esPredeterminado = dto.esPredeterminado;
    }
    if (dto.permisos !== undefined) cambios.permisos = dto.permisos;

    let documento: RolDocument | null;
    try {
      documento = await this.roles
        .findOneAndUpdate({ _id: id, copropiedadId }, cambios, { new: true })
        .exec();
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException('Ya existe un rol con ese nombre');
      }
      throw error;
    }
    if (!documento) throw new NotFoundException(`Rol ${id} no encontrado`);

    return toRol(documento, await this.contarUsuarios(copropiedadId, id));
  }

  /**
   * Physically removes a role of the active coproperty. Unlike a financial
   * document this may go (it is configuration, not a record anyone audits), but
   * not while somebody still holds it: removing it would silently take access
   * away from them.
   */
  async remove(id: string): Promise<{ id: string }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Rol ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const actual = await this.roles.findOne({ _id: id, copropiedadId }).exec();
    if (!actual) throw new NotFoundException(`Rol ${id} no encontrado`);

    if ((await this.contarUsuarios(copropiedadId, id)) > 0) {
      throw new ConflictException(
        'No se puede eliminar un rol con usuarios asignados',
      );
    }
    await this.roles.findOneAndDelete({ _id: id, copropiedadId }).exec();
    return { id };
  }

  /** The Administración permissions a role can bundle, for the editor. */
  permisos(): Permiso[] {
    return PERMISOS_ADMINISTRACION.map(toPermiso);
  }
}
