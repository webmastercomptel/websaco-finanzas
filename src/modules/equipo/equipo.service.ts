// src/modules/equipo/equipo.service.ts
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FirebaseUsuariosService } from '../../common/firebase/firebase-usuarios.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  MiembroEquipo,
  MiembroEquipoCreado,
  ResultadoInvitacion,
  RolDeMiembro,
} from '../../contracts';
import {
  Rol,
  type RolDocument,
} from '../../database/schemas/administracion/rol.schema';
import {
  Account,
  type AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  type AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  Tercero,
  type TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { InvitacionAccesoService } from '../acceso-residentes/invitacion-acceso.service';
import { AuditoriaService } from '../auditoria/auditoria.service';
import { esPermisoAdministracion } from '../casl/permisos-catalogo';
import type { ListarEquipoDto } from './dto/listar-equipo.dto';
import type {
  ActualizarMiembroEquipoDto,
  CrearMiembroEquipoDto,
} from './dto/guardar-miembro.dto';
import {
  toMiembroEquipo,
  type AsignacionEquipo,
  type CuentaEquipo,
} from './equipo.mapper';

/** Mongo's duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

/** An assignment as this service reads it (always `.lean()`). */
interface AsignacionLean extends AsignacionEquipo {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  copropiedadId: Types.ObjectId | null;
  roleIds?: Types.ObjectId[];
}

/** An account as this service reads it (always `.lean()`). */
interface CuentaLean extends CuentaEquipo {
  _id: Types.ObjectId;
}

/** What a validated grant resolves to. */
interface Concesion {
  permisos: string[];
  roleIds: Types.ObjectId[];
}

const unicos = <T>(valores: readonly T[]): T[] => [...new Set(valores)];

/**
 * The coproperty's own staff: accounts with an assignment of scope
 * `copropiedad` on the ACTIVE coproperty.
 *
 * A coproperty administrator is powerful inside the building and nothing
 * outside it, so this module is built around what they may NOT do:
 *
 * - Everything created here is `perfil: 'personal'`. Never `administrativo`,
 *   never an `entidad` scope, never a platform administrator. Those are made and
 *   changed in the platform console (`/usuarios`).
 * - Least privilege: every key a new member ends up with (direct keys and the
 *   keys of the roles attached) must already be one the CALLER holds, so nobody
 *   can mint a stronger account than their own. Platform administrators are
 *   exempt (they hold everything). Creating staff never grants Finanzas keys.
 * - Roles must be roles of THIS coproperty.
 * - The caller cannot edit or deactivate themselves, and cannot touch a
 *   platform administrator or an `administrativo` assignment.
 * - Deactivating only switches this building's assignment off. The Account and
 *   the Firebase identity are never touched: the person may work elsewhere.
 * - An email that already has an account is never taken over silently:
 *   `vincularExistente` must be explicit, and a platform administrator or an
 *   inactive account is refused.
 *
 * The invitation carries no password: see `construirCorreoInvitacion`.
 */
@Injectable()
export class EquipoService {
  constructor(
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Rol.name) private readonly roles: Model<RolDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly firebaseUsuarios: FirebaseUsuariosService,
    private readonly tenant: TenantContextService,
    private readonly invitaciones: InvitacionAccesoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /* ── Reads ─────────────────────────────────────────────── */

  /** Names of the given roles, bounded to this coproperty. */
  private async nombresDeRoles(
    ids: Types.ObjectId[],
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, RolDeMiembro>> {
    if (ids.length === 0) return new Map();
    const encontrados = await this.roles
      .find({ _id: { $in: ids }, copropiedadId })
      .select('nombre')
      .lean()
      .exec();
    return new Map(
      encontrados.map((r) => [
        r._id.toString(),
        { id: r._id.toString(), nombre: r.nombre },
      ]),
    );
  }

  /** The staff assignment of this coproperty, or 404 (also for a malformed id). */
  private async cargarAsignacion(
    id: string,
    copropiedadId: Types.ObjectId,
  ): Promise<AsignacionLean> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Miembro ${id} no encontrado`);
    }
    const asignacion = await this.asignaciones
      .findOne({
        _id: new Types.ObjectId(id),
        copropiedadId,
        alcance: 'copropiedad',
      })
      .lean()
      .exec();
    if (!asignacion) throw new NotFoundException(`Miembro ${id} no encontrado`);
    return asignacion;
  }

  private async cargarCuenta(accountId: Types.ObjectId): Promise<CuentaLean> {
    const cuenta = await this.cuentas.findById(accountId).lean().exec();
    if (!cuenta) throw new NotFoundException('Miembro no encontrado');
    return cuenta;
  }

  async listar(filtros: ListarEquipoDto): Promise<MiembroEquipo[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const estado = filtros.estado ?? 'activo';
    const filtro: Record<string, unknown> = {
      copropiedadId,
      alcance: 'copropiedad',
    };
    if (estado !== 'todos') {
      filtro.estado = estado === 'activo' ? 'active' : 'inactive';
    }

    const asignaciones = (await this.asignaciones
      .find(filtro)
      .lean()
      .exec()) as AsignacionLean[];
    if (asignaciones.length === 0) return [];

    const cuentas = await this.cuentas
      .find({ _id: { $in: asignaciones.map((a) => a.accountId) } })
      .lean()
      .exec();
    const cuentaPorId = new Map(
      cuentas.map((c) => [c._id.toString(), c as CuentaLean]),
    );
    const roles = await this.nombresDeRoles(
      asignaciones.flatMap((a) => a.roleIds ?? []),
      copropiedadId,
    );

    const buscado = filtros.buscar?.trim().toLowerCase();
    return asignaciones
      .flatMap((a) => {
        const cuenta = cuentaPorId.get(a.accountId.toString());
        return cuenta ? [toMiembroEquipo(a, cuenta, roles)] : [];
      })
      .filter(
        (m) =>
          !buscado ||
          m.nombre.toLowerCase().includes(buscado) ||
          m.email.includes(buscado),
      )
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  async obtener(id: string): Promise<MiembroEquipo> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    return this.mapear(
      await this.cargarAsignacion(id, copropiedadId),
      copropiedadId,
    );
  }

  private async mapear(
    asignacion: AsignacionLean,
    copropiedadId: Types.ObjectId,
  ): Promise<MiembroEquipo> {
    const cuenta = await this.cargarCuenta(asignacion.accountId);
    const roles = await this.nombresDeRoles(
      asignacion.roleIds ?? [],
      copropiedadId,
    );
    return toMiembroEquipo(asignacion, cuenta, roles);
  }

  /* ── The ceiling ───────────────────────────────────────── */

  /**
   * Validates and resolves what a request wants to grant, BEFORE any side
   * effect. Order matters for the status code: a key that cannot be assigned at
   * all (a Finanzas key, a typo) is a 400 whoever asks; a valid key the caller
   * does not hold is a 403 naming it.
   */
  private async resolverConcesion(
    rolIds: string[] | undefined,
    permisos: string[] | undefined,
    copropiedadId: Types.ObjectId,
    user: IRequestUser,
  ): Promise<{ permisos?: string[]; roleIds?: Types.ObjectId[] }> {
    const resultado: { permisos?: string[]; roleIds?: Types.ObjectId[] } = {};
    const aOtorgar: string[] = [];

    if (permisos !== undefined) {
      const directos = unicos(permisos);
      const noAsignables = directos.filter((p) => !esPermisoAdministracion(p));
      if (noAsignables.length > 0) {
        throw new BadRequestException(
          `Permisos que el equipo no puede recibir: ${noAsignables.join(', ')}`,
        );
      }
      resultado.permisos = directos;
      aOtorgar.push(...directos);
    }

    if (rolIds !== undefined) {
      const ids = unicos(rolIds);
      const encontrados =
        ids.length === 0
          ? []
          : await this.roles
              .find({
                _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
                copropiedadId,
              })
              .select('permisos')
              .lean()
              .exec();
      if (encontrados.length !== ids.length) {
        throw new BadRequestException(
          'Uno o más roles no existen en esta copropiedad',
        );
      }
      resultado.roleIds = encontrados.map((r) => r._id);
      // Only Administración keys of a role are ever effective (AccesoService
      // drops the rest on read), so only those count as "granted" here.
      aOtorgar.push(
        ...encontrados.flatMap((r) =>
          (r.permisos ?? []).filter(esPermisoAdministracion),
        ),
      );
    }

    if (!user.isPlatformAdmin) {
      const propios = new Set(user.permissions ?? []);
      const faltantes = unicos(aOtorgar).filter((p) => !propios.has(p));
      if (faltantes.length > 0) {
        throw new ForbiddenException(
          `No puedes otorgar permisos que no tienes: ${faltantes.join(', ')}`,
        );
      }
    }
    return resultado;
  }

  /**
   * Platform administrators and `administrativo` assignments are managed from
   * the platform console; a coproperty administrator may not edit, deactivate
   * or re-invite them.
   */
  private exigirGestionable(
    asignacion: AsignacionLean,
    cuenta: CuentaLean,
  ): void {
    if (cuenta.esAdministradorPlataforma) {
      throw new ForbiddenException(
        'Un administrador de la plataforma no se gestiona desde la copropiedad',
      );
    }
    if ((asignacion.perfil ?? 'administrativo') !== 'personal') {
      throw new ForbiddenException(
        'Los administradores de la copropiedad se gestionan desde la consola de la plataforma',
      );
    }
  }

  private exigirNoSerYo(asignacion: AsignacionLean, user: IRequestUser): void {
    if (asignacion.accountId.toString() === user.accountId) {
      throw new ForbiddenException('No puedes modificar tu propio acceso');
    }
  }

  private actor(user: IRequestUser): {
    actorAccountId: string;
    actorNombre: string;
  } {
    return {
      actorAccountId: user.accountId!,
      actorNombre: user.nombre ?? user.email,
    };
  }

  private etiqueta(nombre: string, copropiedadId: Types.ObjectId): string {
    return `Equipo: ${nombre} (copropiedad ${copropiedadId.toString()})`;
  }

  /* ── Writes ────────────────────────────────────────────── */

  /**
   * Gives a person staff access (`personal`) to the active coproperty,
   * creating their sign-in when the email is new.
   *
   * Order: validate everything, then Firebase identity, Account, Assignment.
   * Whatever fails after the identity exists leaves something inert (an
   * account with no assignment grants nothing), and the retry meets the
   * existing-account rule instead of creating a second identity.
   */
  async crear(
    dto: CrearMiembroEquipoDto,
    user: IRequestUser,
  ): Promise<MiembroEquipoCreado> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const concesion = await this.resolverConcesion(
      dto.rolIds,
      dto.permisos,
      copropiedadId,
      user,
    );
    if (
      (concesion.permisos?.length ?? 0) + (concesion.roleIds?.length ?? 0) ===
      0
    ) {
      throw new BadRequestException('Indica al menos un rol o un permiso');
    }
    const grant: Concesion = {
      permisos: concesion.permisos ?? [],
      roleIds: concesion.roleIds ?? [],
    };

    const email = dto.email.trim().toLowerCase();
    const existente = await this.cuentas.findOne({ email }).exec();

    let cuenta: AccountDocument;
    let asignacionId: Types.ObjectId;
    const cuentaExistente = existente !== null;

    if (existente) {
      if (dto.vincularExistente !== true) {
        throw new ConflictException(
          'Ya existe una cuenta con ese correo. Si es la misma persona, confirma el vínculo con vincularExistente',
        );
      }
      if (existente.esAdministradorPlataforma) {
        throw new ConflictException(
          'Esa cuenta es de un administrador de la plataforma y no puede sumarse al equipo desde aquí',
        );
      }
      if (existente.estado !== 'active') {
        throw new ConflictException(
          'Esa cuenta está inactiva: solo la administración de la plataforma puede reactivarla',
        );
      }
      cuenta = existente;
      asignacionId = await this.asignarAExistente(cuenta, grant, copropiedadId);
    } else {
      // Random and never shown: the person gets in through the invitation link
      // and chooses their own password.
      const { uid } = await this.firebaseUsuarios.crear({
        email,
        password: randomBytes(32).toString('base64url'),
        nombre: dto.nombre,
      });
      try {
        cuenta = await this.cuentas.create({
          firebaseUid: uid,
          email,
          nombreCompleto: dto.nombre,
          esAdministradorPlataforma: false,
          estado: 'active',
        });
      } catch (error: unknown) {
        this.relanzar(error);
      }
      asignacionId = await this.crearAsignacion(
        cuenta._id,
        grant,
        copropiedadId,
      );
    }

    await this.auditoria.registrar({
      ...this.actor(user),
      accion: 'crear',
      entidadTipo: 'usuario',
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: this.etiqueta(cuenta.nombreCompleto, copropiedadId),
    });

    const invitacion = await this.invitaciones.enviar({
      accountId: cuenta._id.toString(),
      email: cuenta.email,
      nombre: cuenta.nombreCompleto,
      copropiedadId,
      tipo: 'personal',
      cuentaExistente,
      destino: '/',
    });

    const asignacion = await this.cargarAsignacion(
      asignacionId.toString(),
      copropiedadId,
    );
    return {
      miembro: await this.mapear(asignacion, copropiedadId),
      cuentaExistente,
      ...invitacion,
    };
  }

  /** A unique-index race becomes a 409; anything else is rethrown untouched. */
  private relanzar(error: unknown): never {
    if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
      throw new ConflictException(
        'Otra solicitud creó ese acceso al mismo tiempo: vuelve a intentarlo',
      );
    }
    throw error;
  }

  private async crearAsignacion(
    accountId: Types.ObjectId,
    grant: Concesion,
    copropiedadId: Types.ObjectId,
  ): Promise<Types.ObjectId> {
    try {
      const creada = await this.asignaciones.create({
        accountId,
        perfil: 'personal',
        alcance: 'copropiedad',
        copropiedadId,
        entidadId: null,
        permisos: grant.permisos,
        roleIds: grant.roleIds,
        estado: 'active',
      });
      return creada._id;
    } catch (error: unknown) {
      this.relanzar(error);
    }
  }

  /**
   * Existing account: it may already hold an assignment here. Active is a 409;
   * an inactive `personal` one is reactivated with the NEW grant (never merged
   * with the old); an inactive `administrativo` one is the platform's to restore.
   */
  private async asignarAExistente(
    cuenta: AccountDocument,
    grant: Concesion,
    copropiedadId: Types.ObjectId,
  ): Promise<Types.ObjectId> {
    const previa = (await this.asignaciones
      .findOne({
        accountId: cuenta._id,
        copropiedadId,
        alcance: 'copropiedad',
      })
      .lean()
      .exec()) as AsignacionLean | null;

    if (!previa) {
      return this.crearAsignacion(cuenta._id, grant, copropiedadId);
    }
    if (previa.estado === 'active') {
      throw new ConflictException(
        'Esa persona ya tiene acceso al equipo de esta copropiedad',
      );
    }
    if ((previa.perfil ?? 'administrativo') !== 'personal') {
      throw new ConflictException(
        'Esa persona fue administradora de esta copropiedad: solo la plataforma puede restablecerla',
      );
    }
    const res = await this.asignaciones
      .updateOne(
        {
          _id: previa._id,
          copropiedadId,
          alcance: 'copropiedad',
          perfil: 'personal',
          estado: 'inactive',
        },
        {
          $set: {
            estado: 'active',
            permisos: grant.permisos,
            roleIds: grant.roleIds,
          },
        },
      )
      .exec();
    if (res.matchedCount === 0) {
      throw new ConflictException(
        'El acceso cambió mientras se procesaba: vuelve a intentarlo',
      );
    }
    return previa._id;
  }

  /**
   * Replaces a member's roles and/or direct keys, or renames them. The new
   * grant is held to the same ceiling as a creation. Renaming touches the
   * Account, which is shared by every building the person works in, so it is
   * allowed only when this is their only access anywhere.
   */
  async actualizar(
    id: string,
    dto: ActualizarMiembroEquipoDto,
    user: IRequestUser,
  ): Promise<MiembroEquipo> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const asignacion = await this.cargarAsignacion(id, copropiedadId);
    const cuenta = await this.cargarCuenta(asignacion.accountId);
    this.exigirGestionable(asignacion, cuenta);
    this.exigirNoSerYo(asignacion, user);
    if (asignacion.estado !== 'active') {
      throw new ConflictException(
        'El acceso está desactivado: vuelve a sumar a la persona para reactivarlo',
      );
    }

    const concesion = await this.resolverConcesion(
      dto.rolIds,
      dto.permisos,
      copropiedadId,
      user,
    );
    const permisos = concesion.permisos ?? asignacion.permisos;
    const roleIds = concesion.roleIds ?? asignacion.roleIds ?? [];
    if (permisos.length + roleIds.length === 0) {
      throw new BadRequestException('Indica al menos un rol o un permiso');
    }

    if (dto.nombre !== undefined && dto.nombre !== cuenta.nombreCompleto) {
      await this.exigirCuentaExclusiva(asignacion);
    }

    const cambios: Record<string, unknown> = {};
    if (concesion.permisos !== undefined) cambios.permisos = concesion.permisos;
    if (concesion.roleIds !== undefined) cambios.roleIds = concesion.roleIds;
    if (Object.keys(cambios).length > 0) {
      const res = await this.asignaciones
        .updateOne(
          {
            _id: asignacion._id,
            copropiedadId,
            alcance: 'copropiedad',
            perfil: 'personal',
          },
          { $set: cambios },
        )
        .exec();
      if (res.matchedCount === 0) {
        throw new ConflictException(
          'El acceso cambió mientras se procesaba: vuelve a intentarlo',
        );
      }
    }
    if (dto.nombre !== undefined && dto.nombre !== cuenta.nombreCompleto) {
      await this.cuentas
        .updateOne(
          { _id: cuenta._id },
          { $set: { nombreCompleto: dto.nombre } },
        )
        .exec();
    }

    await this.auditoria.registrar({
      ...this.actor(user),
      accion: 'actualizar',
      entidadTipo: 'usuario',
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: this.etiqueta(
        dto.nombre ?? cuenta.nombreCompleto,
        copropiedadId,
      ),
    });
    return this.obtener(id);
  }

  /** The account is this building's alone: no other access, no resident link. */
  private async exigirCuentaExclusiva(
    asignacion: AsignacionLean,
  ): Promise<void> {
    const [otras, residente] = await Promise.all([
      this.asignaciones
        .exists({
          accountId: asignacion.accountId,
          _id: { $ne: asignacion._id },
        })
        .exec(),
      this.terceros.exists({ accountId: asignacion.accountId }).exec(),
    ]);
    if (otras || residente) {
      throw new ConflictException(
        'Esa cuenta se usa en otras copropiedades: el nombre se cambia desde la consola de la plataforma',
      );
    }
  }

  /**
   * Switches this building's assignment off. Idempotent. The Account and the
   * Firebase identity stay as they are (the person may work in other
   * buildings); access ends on the very next request, because the auth guard
   * re-derives it from live assignments each time.
   */
  async desactivar(id: string, user: IRequestUser): Promise<{ id: string }> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const asignacion = await this.cargarAsignacion(id, copropiedadId);
    const cuenta = await this.cargarCuenta(asignacion.accountId);
    this.exigirGestionable(asignacion, cuenta);
    this.exigirNoSerYo(asignacion, user);
    if (asignacion.estado === 'inactive') return { id };

    const res = await this.asignaciones
      .updateOne(
        {
          _id: asignacion._id,
          copropiedadId,
          alcance: 'copropiedad',
          perfil: 'personal',
        },
        { $set: { estado: 'inactive' } },
      )
      .exec();
    if (res.matchedCount === 0) {
      throw new ConflictException(
        'El acceso cambió mientras se procesaba: vuelve a intentarlo',
      );
    }
    await this.auditoria.registrar({
      ...this.actor(user),
      accion: 'retirar',
      entidadTipo: 'usuario',
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: this.etiqueta(cuenta.nombreCompleto, copropiedadId),
    });
    return { id };
  }

  /** Re-sends the invitation to an active member, to the ACCOUNT's own address. */
  async reenviarInvitacion(id: string): Promise<ResultadoInvitacion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const asignacion = await this.cargarAsignacion(id, copropiedadId);
    const cuenta = await this.cargarCuenta(asignacion.accountId);
    this.exigirGestionable(asignacion, cuenta);
    if (asignacion.estado !== 'active' || cuenta.estado !== 'active') {
      throw new ConflictException(
        'El acceso está desactivado: no se puede invitar',
      );
    }
    return this.invitaciones.enviar({
      accountId: cuenta._id.toString(),
      email: cuenta.email,
      nombre: cuenta.nombreCompleto,
      copropiedadId,
      tipo: 'personal',
      cuentaExistente: false,
      destino: '/',
    });
  }
}
