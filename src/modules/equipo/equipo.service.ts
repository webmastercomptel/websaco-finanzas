// src/modules/equipo/equipo.service.ts
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
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
import {
  clavesEfectivas,
  exigirClavesConocidas,
  exigirDelegacion,
  type CambioDeClaves,
} from '../casl/delegacion';
import { filtroListaExacta } from '../casl/filtro-lista-exacta';
import { CODIGO_CUENTA_EXISTENTE } from '../../common/firebase/codigos-cuenta';
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

/** The 409 every conditional write answers when the row moved under it. */
const MENSAJE_ACCESO_CAMBIO =
  'El acceso cambió mientras se procesaba: vuelve a intentarlo';

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
 * - The delegation cap ("you give, and take away, only what you hold"): a
 *   member's EFFECTIVE keys are their direct keys plus the keys of their roles
 *   (roles of this coproperty only), and every key that CHANGES between before
 *   and after must be one the CALLER holds, by exact key. Adding, removing,
 *   attaching or detaching a role, and deactivating (which removes everything)
 *   are all the same rule, so nobody can mint a stronger account than their own
 *   nor strip a colleague of access they could not have given. Keys that do not
 *   change are never judged. Platform administrators are exempt from the cap
 *   (not from the catalog). Finanzas and Administración keys are treated alike;
 *   what is not offered by either catalog is a 400 when NEW and ignored when it
 *   merely travels back (see `casl/delegacion.ts`).
 * - Writes that depend on a check are conditional on the row still being what
 *   the check read, so a concurrent grant cannot slip past it (409).
 * - Roles must be roles of THIS coproperty.
 * - Every write of a member and its audit entry commit or roll back together
 *   (one Mongo transaction), so a failed audit write leaves no change behind and
 *   a retry cannot skip the entry. The Firebase identity and the Account of a new
 *   person cannot join it and are written first.
 * - The caller cannot add, edit or deactivate themselves, and cannot touch a
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
    @InjectConnection() private readonly connection: Connection,
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

  /* ── The delegation cap ────────────────────────────────── */

  /**
   * The keys each of the given roles carries, bounded to THIS coproperty: a role
   * of another building is simply absent from the map, which is what the read
   * side (`AccesoService`) does with it too. One query for any number of ids, so
   * `actualizar` can load the member's current roles and the requested ones
   * together.
   */
  private async clavesDeRoles(
    ids: readonly Types.ObjectId[],
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, string[]>> {
    const distintos = [
      ...new Map(ids.map((id) => [id.toString(), id])).values(),
    ];
    if (distintos.length === 0) return new Map();
    const encontrados = await this.roles
      .find({ _id: { $in: distintos }, copropiedadId })
      .select('permisos')
      .lean()
      .exec();
    return new Map(
      encontrados.map((r) => [r._id.toString(), r.permisos ?? []]),
    );
  }

  /**
   * The offered keys a member ends up with: direct keys plus the keys of the
   * roles, de-duplicated. A role that no longer resolves contributes nothing,
   * exactly as on the read side. This is the set the cap judges and the audit
   * records.
   */
  private efectivas(
    permisos: readonly string[],
    roleIds: readonly Types.ObjectId[],
    clavesDeRol: ReadonlyMap<string, string[]>,
  ): string[] {
    return clavesEfectivas(
      permisos,
      ...roleIds.map((id) => clavesDeRol.get(id.toString()) ?? []),
    );
  }

  /**
   * Validates what a request wants to set, BEFORE any side effect, and loads the
   * keys of every role involved (the requested ones and, for an update, the ones
   * the member has now). It does NOT apply the cap: the callers know the
   * "before" set. Only requests, never keys, fail here: a role that is not of
   * this coproperty is a 400. (Unknown keys are the callers' 400, which needs
   * the member's current keys; both are decided before any 403.)
   */
  private async resolverConcesion(
    rolIds: string[] | undefined,
    permisos: string[] | undefined,
    copropiedadId: Types.ObjectId,
    rolesActuales: readonly Types.ObjectId[] = [],
  ): Promise<{
    permisos?: string[];
    roleIds?: Types.ObjectId[];
    clavesDeRol: Map<string, string[]>;
  }> {
    const pedidos =
      rolIds === undefined
        ? undefined
        : unicos(rolIds).map((id) => new Types.ObjectId(id));
    const clavesDeRol = await this.clavesDeRoles(
      [...(pedidos ?? []), ...rolesActuales],
      copropiedadId,
    );
    if (pedidos?.some((id) => !clavesDeRol.has(id.toString()))) {
      throw new BadRequestException(
        'Uno o más roles no existen en esta copropiedad',
      );
    }
    return {
      permisos: permisos === undefined ? undefined : unicos(permisos),
      roleIds: pedidos,
      clavesDeRol,
    };
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

  /**
   * Same shape as the other transactional services (`inmuebles-baja`):
   * `withTransaction` may re-run the callback on a transient error, so what it
   * does must be safe to repeat (every write here is conditional or an upsert of
   * the same state).
   */
  private async transaccion<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let resultado!: T;
      await session.withTransaction(async () => {
        resultado = await fn(session);
      });
      return resultado;
    } finally {
      await session.endSession();
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
   * Order: validate everything, then Firebase identity and Account (neither can
   * join a Mongo transaction), then the Assignment together with its audit entry
   * in one transaction. Whatever fails after the identity exists leaves something
   * inert (an account with no assignment grants nothing), and the retry meets the
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
    );
    const grant: Concesion = {
      permisos: concesion.permisos ?? [],
      roleIds: concesion.roleIds ?? [],
    };
    // Every key here is NEW (the "before" of a creation is empty, also when an
    // inactive row is reactivated: its old keys are replaced, never merged).
    exigirClavesConocidas(grant.permisos);
    if (grant.permisos.length + grant.roleIds.length === 0) {
      throw new BadRequestException('Indica al menos un rol o un permiso');
    }
    const cambio = exigirDelegacion(
      user,
      [],
      this.efectivas(grant.permisos, grant.roleIds, concesion.clavesDeRol),
    );

    const email = dto.email.trim().toLowerCase();
    const existente = await this.cuentas.findOne({ email }).exec();

    let cuenta: AccountDocument;
    const cuentaExistente = existente !== null;

    if (existente) {
      // Same rule as update and deactivate: nobody grants themselves access
      // (an entity-scope caller or an inactive own row would otherwise be able
      // to create or reactivate their own assignment here).
      if (existente._id.toString() === user.accountId) {
        throw new ForbiddenException('No puedes modificar tu propio acceso');
      }
      if (dto.vincularExistente !== true) {
        throw new ConflictException({
          code: CODIGO_CUENTA_EXISTENTE,
          message:
            'Ya existe una cuenta con ese correo. Si es la misma persona, confirma el vínculo con vincularExistente',
        });
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
    }

    const cuentaId = cuenta._id;
    const asignacionId = await this.transaccion(async (session) => {
      const id = cuentaExistente
        ? await this.asignarAExistente(cuenta, grant, copropiedadId, session)
        : await this.crearAsignacion(cuentaId, grant, copropiedadId, session);
      await this.auditoria.registrar(
        {
          ...this.actor(user),
          accion: 'crear',
          entidadTipo: 'usuario',
          entidadId: cuentaId.toString(),
          entidadEtiqueta: this.etiqueta(cuenta.nombreCompleto, copropiedadId),
          detalle: cambio,
        },
        session,
      );
      return id;
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
    session: ClientSession,
  ): Promise<Types.ObjectId> {
    try {
      // The array form is what lets Mongoose take options (the session).
      const [creada] = await this.asignaciones.create(
        [
          {
            accountId,
            perfil: 'personal',
            alcance: 'copropiedad',
            copropiedadId,
            entidadId: null,
            permisos: grant.permisos,
            roleIds: grant.roleIds,
            estado: 'active',
          },
        ],
        { session },
      );
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
    session: ClientSession,
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
      return this.crearAsignacion(cuenta._id, grant, copropiedadId, session);
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
        { session },
      )
      .exec();
    if (res.matchedCount === 0) {
      throw new ConflictException(MENSAJE_ACCESO_CAMBIO);
    }
    return previa._id;
  }

  /**
   * Replaces a member's roles and/or direct keys, or renames them. The change
   * is held to the delegation cap: the symmetric difference of the member's
   * effective keys before and after must be keys the caller holds (adding,
   * removing, attaching and detaching a role all count; keys that stay do not).
   * The write applies only while `permisos` and `roleIds` are still what the
   * check read, otherwise 409 and nothing is written (no rename, no audit), so
   * a concurrent grant cannot slip past the check. A rename alone touches no
   * keys: no cap, no conditional write. Renaming touches the Account, which is
   * shared by every building the person works in, so it is allowed only when
   * this is their only access anywhere.
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

    const permisosActuales = asignacion.permisos ?? [];
    const rolesActuales = asignacion.roleIds ?? [];
    const tocaClaves = dto.permisos !== undefined || dto.rolIds !== undefined;
    let cambio: CambioDeClaves = { agregadas: [], quitadas: [] };
    const cambios: Record<string, unknown> = {};

    if (tocaClaves) {
      const concesion = await this.resolverConcesion(
        dto.rolIds,
        dto.permisos,
        copropiedadId,
        rolesActuales,
      );
      const permisos = concesion.permisos ?? permisosActuales;
      const roleIds = concesion.roleIds ?? rolesActuales;
      // A key already stored travels back untouched; only NEW ones must exist.
      exigirClavesConocidas(permisos, permisosActuales);
      if (permisos.length + roleIds.length === 0) {
        throw new BadRequestException('Indica al menos un rol o un permiso');
      }
      cambio = exigirDelegacion(
        user,
        this.efectivas(permisosActuales, rolesActuales, concesion.clavesDeRol),
        this.efectivas(permisos, roleIds, concesion.clavesDeRol),
      );
      if (concesion.permisos !== undefined) cambios.permisos = permisos;
      if (concesion.roleIds !== undefined) cambios.roleIds = roleIds;
    }

    const nombreNuevo =
      dto.nombre !== undefined && dto.nombre !== cuenta.nombreCompleto
        ? dto.nombre
        : undefined;
    if (nombreNuevo !== undefined) {
      await this.exigirCuentaExclusiva(asignacion);
    }

    // Keys, name and audit entry are one unit: a refused or failed step undoes
    // the others, so no change is ever saved without its entry (nor the reverse).
    await this.transaccion(async (session) => {
      if (Object.keys(cambios).length > 0) {
        const res = await this.asignaciones
          .updateOne(
            {
              _id: asignacion._id,
              copropiedadId,
              alcance: 'copropiedad',
              perfil: 'personal',
              estado: 'active',
              $and: [
                filtroListaExacta('permisos', permisosActuales),
                filtroListaExacta('roleIds', rolesActuales),
              ],
            },
            { $set: cambios },
            { session },
          )
          .exec();
        if (res.matchedCount === 0) {
          throw new ConflictException(MENSAJE_ACCESO_CAMBIO);
        }
      }
      if (nombreNuevo !== undefined) {
        await this.cuentas
          .updateOne(
            { _id: cuenta._id },
            { $set: { nombreCompleto: nombreNuevo } },
            { session },
          )
          .exec();
      }
      await this.auditoria.registrar(
        {
          ...this.actor(user),
          accion: 'actualizar',
          entidadTipo: 'usuario',
          entidadId: cuenta._id.toString(),
          entidadEtiqueta: this.etiqueta(
            dto.nombre ?? cuenta.nombreCompleto,
            copropiedadId,
          ),
          detalle: cambio,
        },
        session,
      );
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
   *
   * Deactivating removes every key the member has, so it is the delegation cap
   * with `after = []`: the caller must hold all of the member's effective keys
   * (direct and through roles), otherwise a junior could strip a richer
   * colleague of access they could not have given. A member whose effective set
   * is empty (only legacy or not-offered keys) can always be deactivated. The
   * write is conditional on the row still being active with the same keys it was
   * checked against. An already inactive member answers 200 with no check, no
   * write and no audit entry.
   */
  async desactivar(id: string, user: IRequestUser): Promise<{ id: string }> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const asignacion = await this.cargarAsignacion(id, copropiedadId);
    const cuenta = await this.cargarCuenta(asignacion.accountId);
    this.exigirGestionable(asignacion, cuenta);
    this.exigirNoSerYo(asignacion, user);
    if (asignacion.estado === 'inactive') return { id };

    const permisosActuales = asignacion.permisos ?? [];
    const rolesActuales = asignacion.roleIds ?? [];
    const clavesDeRol = await this.clavesDeRoles(rolesActuales, copropiedadId);
    const cambio = exigirDelegacion(
      user,
      this.efectivas(permisosActuales, rolesActuales, clavesDeRol),
      [],
      'No puedes desactivar a alguien con permisos que tú no tienes',
    );

    await this.transaccion(async (session) => {
      const res = await this.asignaciones
        .updateOne(
          {
            _id: asignacion._id,
            copropiedadId,
            alcance: 'copropiedad',
            perfil: 'personal',
            estado: 'active',
            $and: [
              filtroListaExacta('permisos', permisosActuales),
              filtroListaExacta('roleIds', rolesActuales),
            ],
          },
          { $set: { estado: 'inactive' } },
          { session },
        )
        .exec();
      if (res.matchedCount === 0) {
        throw new ConflictException(MENSAJE_ACCESO_CAMBIO);
      }
      await this.auditoria.registrar(
        {
          ...this.actor(user),
          accion: 'retirar',
          entidadTipo: 'usuario',
          entidadId: cuenta._id.toString(),
          entidadEtiqueta: this.etiqueta(cuenta.nombreCompleto, copropiedadId),
          detalle: cambio,
        },
        session,
      );
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
