// src/modules/roles/roles.service.ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { siguienteNumero } from '../../common/consecutivos/codigo-consecutivo';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
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
 * Least privilege, the same rule `EquipoService` applies: a non-platform caller
 * may only put into (or take out of) a role the keys it holds itself. Without
 * it, anyone with `roles.gestionar` could write every key into a role they hold
 * and receive it on the next request (`AccesoService` unions role keys).
 */
const exigirClavesPropias = (
  user: IRequestUser,
  claves: readonly string[],
): void => {
  if (user.isPlatformAdmin) return;
  const propias = new Set(user.permissions ?? []);
  const faltantes = [...new Set(claves)].filter((c) => !propias.has(c));
  if (faltantes.length > 0) {
    throw new ForbiddenException(
      `No puedes otorgar ni quitar permisos que no tienes: ${faltantes.join(', ')}`,
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

  async create(dto: CrearRolDto, user: IRequestUser): Promise<RolContrato> {
    exigirPermisosAsignables(dto.permisos);
    exigirClavesPropias(user, dto.permisos ?? []);
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

  async update(
    id: string,
    dto: ActualizarRolDto,
    user: IRequestUser,
  ): Promise<RolContrato> {
    exigirPermisosAsignables(dto.permisos);
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Rol ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    // The keys the check was made against: the write only applies while the
    // role still has exactly them, so a concurrent edit cannot make this one
    // silently drop a key its author could not have removed.
    const revisados =
      dto.permisos !== undefined
        ? await this.exigirCambioDePermisosPermitido(
            copropiedadId,
            id,
            dto.permisos,
            user,
          )
        : undefined;
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
        .findOneAndUpdate(
          {
            _id: id,
            copropiedadId,
            ...(revisados !== undefined ? { permisos: revisados } : {}),
          },
          cambios,
          { new: true },
        )
        .exec();
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException('Ya existe un rol con ese nombre');
      }
      throw error;
    }
    if (!documento && revisados !== undefined) {
      // It existed at the check, so what no longer matches is its keys.
      throw new ConflictException(
        'Otra persona cambió los permisos de este rol mientras lo editabas. Recarga y vuelve a intentarlo.',
      );
    }
    if (!documento) throw new NotFoundException(`Rol ${id} no encontrado`);

    return toRol(documento, await this.contarUsuarios(copropiedadId, id));
  }

  /**
   * Guards a change to a role's keys: the caller must hold every key added AND
   * every key removed (taking away what you could not give is also a privilege
   * change for everyone holding the role), and may not rewrite the keys of a
   * role they hold themselves. Platform administrators are exempt. A missing
   * role is left to the update's own 404.
   *
   * Returns the keys the check was made against (undefined when nothing was
   * checked), so the caller can make its write conditional on them.
   */
  private async exigirCambioDePermisosPermitido(
    copropiedadId: Types.ObjectId,
    id: string,
    nuevos: readonly string[],
    user: IRequestUser,
  ): Promise<string[] | undefined> {
    if (user.isPlatformAdmin) return undefined;
    const actual = await this.roles.findOne({ _id: id, copropiedadId }).exec();
    if (!actual) return undefined;

    const antes = new Set(actual.permisos ?? []);
    const despues = new Set(nuevos);
    const cambiadas = [
      ...[...despues].filter((c) => !antes.has(c)),
      ...[...antes].filter((c) => !despues.has(c)),
    ];
    exigirClavesPropias(user, cambiadas);

    if (user.accountId && Types.ObjectId.isValid(user.accountId)) {
      const loTiene = await this.asignaciones
        .exists({
          accountId: new Types.ObjectId(user.accountId),
          copropiedadId,
          roleIds: new Types.ObjectId(id),
          estado: 'active',
        })
        .exec();
      if (loTiene) {
        throw new ForbiddenException(
          'No puedes cambiar los permisos de un rol que tienes asignado',
        );
      }
    }
    // Exact array as stored (same order), so the equality filter matches it.
    return actual.permisos ? [...actual.permisos] : undefined;
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
