// src/modules/roles/roles.service.ts
import {
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
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import type { Permiso, Rol as RolContrato } from '../../contracts';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  cambioDeClaves,
  exigirClavesConocidas,
  exigirDelegacion,
  type CambioDeClaves,
} from '../casl/delegacion';
import { filtroListaExacta } from '../casl/filtro-lista-exacta';
import { PERMISOS_ADMINISTRACION } from '../casl/permisos-catalogo';
import type { ActualizarRolDto, CrearRolDto } from './dto/guardar-rol.dto';
import { toPermiso, toRol } from './roles.mapper';

/** Mongo's duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

/**
 * Roles of the ACTIVE coproperty (the tenant comes from the request context,
 * never from the payload). Every lookup filters by id AND coproperty, so a role
 * of another building is a 404, not a leak.
 *
 * A role is a bundle of ANY offered keys, Finanzas and Administración alike, and
 * its writes are held to the same delegation cap as Equipo (`casl/delegacion`):
 * the caller must hold, by exact key, every key the write adds to or takes out
 * of the role; a platform admin is exempt from the cap, not from the catalog.
 * The cap is judged on the ROLE's keys and not fanned out to its holders: the
 * per-key rule answers the same for every holder. A key the role stores that is
 * not offered (a legacy `facturas.gestionar`) is never judged and travels back
 * untouched. Whether the coproperty contracted the key's module is not asked
 * here: a key of a module it lacks is stored and inert, and wakes up if the
 * module is contracted later.
 *
 * Every write is audited (`entidadTipo: 'rol'`, with `detalle` = the keys the
 * cap judged), deletion included. The entry is written after the change and
 * only when it succeeded, so a refused request leaves none.
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
    private readonly auditoria: AuditoriaService,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
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

  /** The audit entry of a role write; `detalle` is what the cap judged. */
  private auditar(
    user: IRequestUser,
    accion: 'crear' | 'actualizar' | 'eliminar',
    rol: { _id: Types.ObjectId | string; nombre: string },
    copropiedadId: Types.ObjectId,
    detalle: CambioDeClaves,
  ): Promise<void> {
    return this.auditoria.registrar({
      actorAccountId: user.accountId!,
      actorNombre: user.nombre ?? user.email,
      accion,
      entidadTipo: 'rol',
      entidadId: rol._id.toString(),
      entidadEtiqueta: `Rol: ${rol.nombre} (copropiedad ${copropiedadId.toString()})`,
      detalle,
    });
  }

  async create(dto: CrearRolDto, user: IRequestUser): Promise<RolContrato> {
    const permisos = dto.permisos ?? [];
    // 400 (a key that does not exist) before 403 (a key you do not hold).
    exigirClavesConocidas(permisos);
    const cambio = exigirDelegacion(user, [], permisos);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const codigo = await this.siguienteCodigoDeRol(copropiedadId);
    let creado: RolDocument;
    try {
      creado = await this.roles.create({
        copropiedadId,
        codigo,
        nombre: dto.nombre,
        descripcion: dto.descripcion ?? '',
        ...(dto.color !== undefined && { color: dto.color }),
        esPredeterminado: dto.esPredeterminado ?? false,
        permisos,
      });
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException('Ya existe un rol con ese nombre');
      }
      throw error;
    }
    await this.auditar(user, 'crear', creado, copropiedadId, cambio);
    return toRol(creado, 0);
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
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Rol ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    // Only a write that carries `permisos` touches keys: a rename, a colour or
    // the default flag changes nobody's access, so it needs no cap and no
    // condition on the stored keys.
    let revisados: string[] | undefined;
    let cambio: CambioDeClaves = { agregadas: [], quitadas: [] };
    if (dto.permisos !== undefined) {
      const actual = await this.roles
        .findOne({ _id: id, copropiedadId })
        .exec();
      if (!actual) throw new NotFoundException(`Rol ${id} no encontrado`);
      // The keys the check is made against: the write only applies while the
      // role still has exactly them, so a concurrent edit cannot make this one
      // silently drop a key its author could not have removed.
      revisados = [...(actual.permisos ?? [])];
      exigirClavesConocidas(dto.permisos, revisados);
      cambio = exigirDelegacion(user, revisados, dto.permisos);
      await this.exigirNoTenerElRol(user, copropiedadId, id);
      if (cambio.agregadas.length > 0 || cambio.quitadas.length > 0) {
        await this.exigirTitularesAdministrables(user, copropiedadId, id);
      }
    }
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
            ...(revisados !== undefined
              ? filtroListaExacta('permisos', revisados)
              : {}),
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

    await this.auditar(user, 'actualizar', documento, copropiedadId, cambio);
    return toRol(documento, await this.contarUsuarios(copropiedadId, id));
  }

  /**
   * Whoever holds a role may not rewrite its keys, even with the same list:
   * they would be editing their own access. Renaming it is fine. A platform
   * admin is exempt, as from every cap here.
   */
  private async exigirNoTenerElRol(
    user: IRequestUser,
    copropiedadId: Types.ObjectId,
    id: string,
  ): Promise<void> {
    if (user.isPlatformAdmin) return;
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) return;
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

  /**
   * The keys of a role reach every active holder, so changing them changes the
   * access of rows the team screens must not touch: an `administrativo` row
   * (only a platform admin edits those; one moved from `personal` in the
   * Usuarios screen keeps its `roleIds`) and any account of a platform admin.
   * Refused when ANY active holder in this coproperty is one of them; a platform
   * admin is exempt. Only called when the keys really change: a rename, or the
   * same keys sent again, changes nobody's access.
   */
  private async exigirTitularesAdministrables(
    user: IRequestUser,
    copropiedadId: Types.ObjectId,
    id: string,
  ): Promise<void> {
    if (user.isPlatformAdmin) return;
    const titulares = await this.asignaciones
      .find({ copropiedadId, roleIds: id, estado: 'active' })
      .select({ perfil: 1, accountId: 1 })
      .lean()
      .exec();
    // A legacy row with no `perfil` reads as `administrativo`.
    const hayAdministrativo = titulares.some(
      (titular) => (titular.perfil ?? 'administrativo') !== 'personal',
    );
    const deCuentaDePlataforma =
      !hayAdministrativo &&
      titulares.length > 0 &&
      (await this.cuentas
        .exists({
          _id: { $in: titulares.map((titular) => titular.accountId) },
          esAdministradorPlataforma: true,
        })
        .exec());
    if (hayAdministrativo || deCuentaDePlataforma) {
      throw new ForbiddenException(
        'Este rol lo tiene una cuenta que se administra desde la plataforma: sus permisos no se pueden cambiar aquí',
      );
    }
  }

  /**
   * Physically removes a role of the active coproperty. Unlike a financial
   * document this may go (it is configuration, not a record anyone audits as a
   * balance), but not while somebody still holds it: removing it would silently
   * take access away from them. With no holder it changes nobody's effective
   * set, so it needs no key cap, but it is audited like any role write, with
   * the keys it carried as `quitadas`.
   */
  async remove(id: string, user: IRequestUser): Promise<{ id: string }> {
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
    await this.auditar(
      user,
      'eliminar',
      actual,
      copropiedadId,
      cambioDeClaves(actual.permisos ?? [], []),
    );
    return { id };
  }

  /**
   * The Administración permissions a role can bundle, for the editor. Kept as
   * is on purpose: the Finanzas catalog is served by its own route, and a
   * stored Finanzas key is validated by the cap, not by this list.
   */
  permisos(): Permiso[] {
    return PERMISOS_ADMINISTRACION.map(toPermiso);
  }
}
