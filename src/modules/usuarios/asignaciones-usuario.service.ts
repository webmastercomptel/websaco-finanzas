// src/modules/usuarios/asignaciones-usuario.service.ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
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
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  EntidadAdministradora,
  type EntidadAdministradoraDocument,
} from '../../database/schemas/entidades/entidad-administradora.schema';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  cambioDeClaves,
  clavesEfectivas,
  exigirClavesConocidas,
  type CambioDeClaves,
} from '../casl/delegacion';
import { filtroListaExacta } from '../casl/filtro-lista-exacta';
import type { PerfilAsignacion } from '../casl/permisos-catalogo';
import type {
  ActualizarAsignacionUsuarioDto,
  AgregarAsignacionUsuarioDto,
} from './dto/guardar-asignacion-usuario.dto';
import {
  accionesDesdeUsuarios,
  estadoAlReactivar,
} from './asignaciones-usuario.reglas';

/** Mongo's unique-index violation (E11000). */
const CLAVE_DUPLICADA = 11000;

/** The 409 every conditional write answers when the row moved under it. */
const MENSAJE_ACCESO_CAMBIO =
  'El acceso cambió mientras se procesaba: vuelve a intentarlo';

const MENSAJE_ACCESO_DE_EQUIPO =
  'Este acceso es del equipo de su copropiedad: se gestiona desde Equipo';

/**
 * 24 hex characters and nothing else. `Types.ObjectId.isValid` also accepts any
 * 12-character string, which would reach a query as a different id than the one
 * typed; an id that is not this is a 404, never a 500 and never a lookalike.
 */
const ID_HEX = /^[0-9a-fA-F]{24}$/;

const unicos = <T>(valores: readonly T[]): T[] => [...new Set(valores)];

/** Same members, whatever the order. */
const mismoConjunto = (a: readonly string[], b: readonly string[]): boolean => {
  const conjuntoB = new Set(b);
  const conjuntoA = new Set(a);
  return (
    conjuntoA.size === conjuntoB.size &&
    [...conjuntoA].every((x) => conjuntoB.has(x))
  );
};

/** The authenticated caller, as the audit trail needs it: never from the body. */
export interface ActorUsuarios {
  accountId: string;
  nombre: string;
}

/** A row as this service reads it (always `.lean()`). */
interface FilaLean {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  perfil?: 'administrativo' | 'personal';
  alcance: 'copropiedad' | 'entidad';
  copropiedadId: Types.ObjectId | null;
  entidadId: Types.ObjectId | null;
  permisos?: string[];
  roleIds?: Types.ObjectId[];
  estado: 'active' | 'inactive';
}

/** The target a request names, resolved: the one id that matches its scope. */
interface Destino {
  alcance: 'copropiedad' | 'entidad';
  copropiedadId: Types.ObjectId | null;
  entidadId: Types.ObjectId | null;
  /** Null when the target no longer resolves. */
  nombre: string | null;
}

/** What a new row is made of (the unique index is `accountId` + target). */
export interface NuevaAsignacion {
  accountId: Types.ObjectId;
  alcance: 'copropiedad' | 'entidad';
  copropiedadId: Types.ObjectId | null;
  entidadId: Types.ObjectId | null;
  permisos: string[];
  /**
   * Defaults to `administrativo`, the only profile this screen writes. Only
   * `UsuariosService.create` passes one, while `CrearUsuarioDto` still accepts
   * `perfil`; it goes with that field.
   */
  perfil?: PerfilAsignacion;
}

/**
 * Manages ONE assignment row at a time from the platform Usuarios screen, so a
 * person's assignments ADD UP: no call here replaces, retires or blocks another
 * row, and none writes the Account.
 *
 * - The caller is a platform admin, so there is no delegation cap (the
 *   controller sits behind `PlatformAdminGuard`). The only rule on keys is the
 *   catalog: a NEW key must be offered (400 naming it), a key already stored on
 *   the row and re-sent is never judged (`exigirClavesConocidas(after, before)`).
 * - Every write is a single-document `create` or `updateOne` whose filter names
 *   the row (`_id` and `accountId`, or `accountId` and target for an add), and
 *   applies only while the row is still what the check read (`estado`,
 *   `permisos`, `roleIds`, and "not an Equipo row"), otherwise 409.
 * - Every write and its audit entry commit or roll back together (one Mongo
 *   transaction, the Equipo pattern), and the entry carries `detalle`: the
 *   offered keys the row's EFFECTIVE set gained and lost (its own keys plus the
 *   keys of its roles, empty while the row is inactive).
 * - Rows created by Equipo (`personal`) are read-only here. The only Usuarios
 *   operation that touches one is POSTing its target while it is INACTIVE,
 *   which reactivates it as an `administrativo` row.
 *
 * No Firebase: this service reads and writes Mongo only (the identity belongs to
 * `FirebaseUsuariosService`).
 */
@Injectable()
export class AsignacionesUsuarioService {
  constructor(
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Rol.name) private readonly roles: Model<RolDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(EntidadAdministradora.name)
    private readonly entidades: Model<EntidadAdministradoraDocument>,
    private readonly auditoria: AuditoriaService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /* ── Reads ─────────────────────────────────────────────── */

  /** The account, or 404 (also for a malformed id). */
  private async cargarCuenta(id: string): Promise<{
    _id: Types.ObjectId;
    nombreCompleto: string;
    esAdministradorPlataforma: boolean;
  }> {
    if (!ID_HEX.test(id)) {
      throw new NotFoundException(`No se encontró el usuario ${id}`);
    }
    const cuenta = await this.cuentas
      .findById(new Types.ObjectId(id))
      .lean()
      .exec();
    if (!cuenta) throw new NotFoundException(`No se encontró el usuario ${id}`);
    return cuenta;
  }

  /** The row of THIS account, or 404 (also for a malformed id or another account's row). */
  private async cargarFila(
    accountId: Types.ObjectId,
    id: string,
  ): Promise<FilaLean> {
    if (!ID_HEX.test(id)) {
      throw new NotFoundException(`No se encontró el acceso ${id}`);
    }
    const fila = (await this.asignaciones
      .findOne({ _id: new Types.ObjectId(id), accountId })
      .lean()
      .exec()) as FilaLean | null;
    if (!fila) throw new NotFoundException(`No se encontró el acceso ${id}`);
    return fila;
  }

  /**
   * The target a POST names, which must exist (404 otherwise). An INACTIVE
   * target is accepted: it is inert on read, and the row can be prepared for
   * when it comes back. The coproperty and the entity are platform-level
   * records, so `findById` is the right lookup (no tenant to scope by).
   */
  private async resolverDestino(
    dto: AgregarAsignacionUsuarioDto,
  ): Promise<Destino> {
    if (dto.alcance === 'copropiedad') {
      if (!dto.copropiedadId || !ID_HEX.test(dto.copropiedadId)) {
        throw new BadRequestException('Indica la copropiedad');
      }
      const copropiedadId = new Types.ObjectId(dto.copropiedadId);
      const encontrada = await this.copropiedades
        .findById(copropiedadId)
        .select('nombre')
        .lean()
        .exec();
      if (!encontrada) throw new NotFoundException('La copropiedad no existe');
      return {
        alcance: 'copropiedad',
        copropiedadId,
        entidadId: null,
        nombre: encontrada.nombre,
      };
    }
    if (!dto.entidadId || !ID_HEX.test(dto.entidadId)) {
      throw new BadRequestException('Indica la entidad');
    }
    const entidadId = new Types.ObjectId(dto.entidadId);
    const encontrada = await this.entidades
      .findById(entidadId)
      .select('nombre')
      .lean()
      .exec();
    if (!encontrada) throw new NotFoundException('La entidad no existe');
    return {
      alcance: 'entidad',
      copropiedadId: null,
      entidadId,
      nombre: encontrada.nombre,
    };
  }

  /** The name of a stored row's target, or null when it no longer resolves. */
  private async nombreDelDestino(fila: FilaLean): Promise<string | null> {
    if (fila.alcance === 'copropiedad' && fila.copropiedadId) {
      const c = await this.copropiedades
        .findById(fila.copropiedadId)
        .select('nombre')
        .lean()
        .exec();
      return c?.nombre ?? null;
    }
    if (fila.alcance === 'entidad' && fila.entidadId) {
      const e = await this.entidades
        .findById(fila.entidadId)
        .select('nombre')
        .lean()
        .exec();
      return e?.nombre ?? null;
    }
    return null;
  }

  /**
   * The keys each of the given roles carries, bounded to THIS coproperty, as the
   * read side does (a role of another building is simply absent). Nothing is
   * queried when there are no roles, or for an `entidad` row, which ignores them.
   */
  private async clavesDeRoles(
    ids: readonly Types.ObjectId[],
    copropiedadId: Types.ObjectId | null,
  ): Promise<Map<string, string[]>> {
    const distintos = [
      ...new Map(ids.map((id) => [id.toString(), id])).values(),
    ];
    if (distintos.length === 0 || !copropiedadId) return new Map();
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
   * The offered keys a row grants: its own plus the keys of the roles it names
   * (a `copropiedad` row only). This is the set the audit's `detalle` diffs.
   */
  private efectivas(
    alcance: 'copropiedad' | 'entidad',
    permisos: readonly string[],
    roleIds: readonly Types.ObjectId[],
    clavesDeRol: ReadonlyMap<string, string[]>,
  ): string[] {
    const deRoles =
      alcance === 'copropiedad'
        ? roleIds.map((id) => clavesDeRol.get(id.toString()) ?? [])
        : [];
    return clavesEfectivas(permisos, ...deRoles);
  }

  /* ── Plumbing ──────────────────────────────────────────── */

  /**
   * Same shape as the other transactional services: `withTransaction` may re-run
   * the callback on a transient error, so what it does must be safe to repeat
   * (every write is conditional or fails on the unique index).
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

  private etiqueta(persona: string, alcance: string, destino: string): string {
    return `Acceso: ${persona} (${alcance} ${destino})`;
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

  /**
   * Inserts ONE new row, `administrativo` unless told otherwise, active, with
   * no roles. The array form
   * of `create` is what lets Mongoose take the session. Also used by
   * `UsuariosService.create` for the first assignment of a new account, inside
   * its own transaction. A concurrent insert of the same target (E11000) is a
   * 409.
   */
  async insertar(
    datos: NuevaAsignacion,
    session: ClientSession,
  ): Promise<Types.ObjectId> {
    try {
      const [creada] = await this.asignaciones.create(
        [
          {
            accountId: datos.accountId,
            alcance: datos.alcance,
            copropiedadId: datos.copropiedadId,
            entidadId: datos.entidadId,
            permisos: datos.permisos,
            perfil: datos.perfil ?? 'administrativo',
            roleIds: [],
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
   * The ONE write that changes a row: it applies only while the row is still
   * what the check read (same `estado`, same `permisos` and `roleIds`, and
   * still an Equipo row or still not one), and names the row by `_id` AND
   * `accountId`, so it can never match a different row or account. `perfil` is
   * never filtered on `'administrativo'`: legacy rows have no such field in the
   * database. No match means somebody changed the row first: 409, no audit.
   */
  private async escribir(
    fila: FilaLean,
    cambios: Record<string, unknown>,
    session: ClientSession,
  ): Promise<void> {
    const res = await this.asignaciones
      .updateOne(
        {
          _id: fila._id,
          accountId: fila.accountId,
          estado: fila.estado,
          perfil:
            (fila.perfil ?? 'administrativo') === 'personal'
              ? 'personal'
              : { $ne: 'personal' },
          $and: [
            filtroListaExacta('permisos', fila.permisos ?? []),
            filtroListaExacta('roleIds', fila.roleIds ?? []),
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

  /**
   * Reactivates an INACTIVE row (assumption 3): active again, `administrativo`,
   * the given keys and the roles `estadoAlReactivar` leaves. Shared by the POST
   * on an inactive target and the PATCH `estado: 'activo'`, so the semantics
   * live in one place.
   */
  private reactivar(
    fila: FilaLean,
    permisos: string[],
    session: ClientSession,
  ): Promise<void> {
    return this.escribir(
      fila,
      { estado: 'active', permisos, ...estadoAlReactivar(fila) },
      session,
    );
  }

  /* ── Writes ────────────────────────────────────────────── */

  /**
   * POST: gives the account access to ONE more target. Order: the account (404),
   * the target (404), a platform-admin account (409), the keys (400), and only
   * then the transaction, where the state of the target decides:
   *
   * - no row: a new one is inserted;
   * - an INACTIVE row (any profile): reactivated (assumption 3);
   * - an ACTIVE row: 409, nothing written (no takeover of an Equipo row, no
   *   merge; the person edits an `administrativo` one from their list).
   *
   * No other row is read or written, and the Account never is.
   */
  async agregar(
    accountId: string,
    dto: AgregarAsignacionUsuarioDto,
    actor: ActorUsuarios,
  ): Promise<void> {
    const cuenta = await this.cargarCuenta(accountId);
    const destino = await this.resolverDestino(dto);
    if (cuenta.esAdministradorPlataforma) {
      throw new ConflictException(
        'Un administrador de la plataforma tiene acceso total y no necesita accesos asignados',
      );
    }
    const permisos = unicos(dto.permisos);
    // Every key here is NEW: the "before" of an add is empty, also when an
    // inactive row is reactivated (its old keys are replaced, never merged).
    exigirClavesConocidas(permisos);

    const filtroDestino =
      destino.alcance === 'copropiedad'
        ? { copropiedadId: destino.copropiedadId }
        : { entidadId: destino.entidadId };

    await this.transaccion(async (session) => {
      const previa = (await this.asignaciones
        .findOne({
          accountId: cuenta._id,
          alcance: destino.alcance,
          ...filtroDestino,
        })
        .session(session)
        .lean()
        .exec()) as FilaLean | null;

      let despues: string[];
      if (!previa) {
        await this.insertar(
          {
            accountId: cuenta._id,
            alcance: destino.alcance,
            copropiedadId: destino.copropiedadId,
            entidadId: destino.entidadId,
            permisos,
          },
          session,
        );
        despues = clavesEfectivas(permisos);
      } else if (previa.estado === 'active') {
        throw new ConflictException(
          (previa.perfil ?? 'administrativo') === 'personal'
            ? 'La persona ya tiene un acceso activo ahí desde Equipo: se gestiona desde Equipo, en esa copropiedad'
            : 'La persona ya tiene un acceso activo ahí: edítalo desde su lista de accesos',
        );
      } else {
        await this.reactivar(previa, permisos, session);
        const roleIds = estadoAlReactivar(previa).roleIds;
        despues = this.efectivas(
          destino.alcance,
          permisos,
          roleIds,
          await this.clavesDeRoles(roleIds, destino.copropiedadId),
        );
      }

      await this.auditoria.registrar(
        {
          actorAccountId: actor.accountId,
          actorNombre: actor.nombre,
          accion: 'crear',
          entidadTipo: 'usuario',
          entidadId: cuenta._id.toString(),
          entidadEtiqueta: this.etiqueta(
            cuenta.nombreCompleto,
            destino.alcance,
            destino.nombre ??
              (destino.copropiedadId ?? destino.entidadId)!.toString(),
          ),
          // An inactive row (or no row) grants nothing: "before" is empty.
          detalle: cambioDeClaves([], despues),
        },
        session,
      );
    });
  }

  /**
   * PATCH: edits the keys of ONE row, its `estado`, or both. Order: the account
   * and the row of THAT account (404), the profile rule (403), the keys (400),
   * and only then the write. The target, the profile and the roles never change
   * here (reactivating clears the roles, per `estadoAlReactivar`).
   *
   * A request that changes nothing (same keys, the state the row already has)
   * answers with no write and no audit entry. A key already stored on the row
   * travels back untouched and is never judged; only a NEW key must be offered.
   */
  async actualizar(
    accountId: string,
    asignacionId: string,
    dto: ActualizarAsignacionUsuarioDto,
    actor: ActorUsuarios,
  ): Promise<void> {
    const cuenta = await this.cargarCuenta(accountId);
    const fila = await this.cargarFila(cuenta._id, asignacionId);

    const acciones = accionesDesdeUsuarios(fila.perfil ?? 'administrativo');
    if (
      (dto.permisos !== undefined && !acciones.editarClaves) ||
      (dto.estado === 'inactivo' && !acciones.desactivar) ||
      (dto.estado === 'activo' && !acciones.reactivar)
    ) {
      throw new ForbiddenException(MENSAJE_ACCESO_DE_EQUIPO);
    }

    const permisosActuales = fila.permisos ?? [];
    const roleIdsActuales = fila.roleIds ?? [];
    const activa = fila.estado === 'active';
    const reactivando = dto.estado === 'activo' && !activa;
    const desactivando = dto.estado === 'inactivo' && activa;

    const permisosPedidos =
      dto.permisos === undefined ? undefined : unicos(dto.permisos);
    // A key already stored travels back untouched; only NEW ones must exist.
    if (permisosPedidos)
      exigirClavesConocidas(permisosPedidos, permisosActuales);
    const permisos = permisosPedidos ?? permisosActuales;
    const cambiaClaves =
      permisosPedidos !== undefined &&
      !mismoConjunto(permisosPedidos, permisosActuales);

    if (!reactivando && !desactivando && !cambiaClaves) return;

    const cambios: Record<string, unknown> = reactivando
      ? { estado: 'active', permisos, ...estadoAlReactivar(fila) }
      : desactivando
        ? { estado: 'inactive', ...(cambiaClaves ? { permisos } : {}) }
        : { permisos };

    // The effective sets, with ONE query for the roles of both sides: what the
    // row grants today (nothing while it is inactive) against what it will.
    const roleIdsDespues = reactivando
      ? estadoAlReactivar(fila).roleIds
      : roleIdsActuales;
    const clavesDeRol = await this.clavesDeRoles(
      [...roleIdsActuales, ...roleIdsDespues],
      fila.copropiedadId,
    );
    const quedaActiva = reactivando || (activa && !desactivando);
    const detalle: CambioDeClaves = cambioDeClaves(
      activa
        ? this.efectivas(
            fila.alcance,
            permisosActuales,
            roleIdsActuales,
            clavesDeRol,
          )
        : [],
      quedaActiva
        ? this.efectivas(fila.alcance, permisos, roleIdsDespues, clavesDeRol)
        : [],
    );

    const nombreDestino =
      (await this.nombreDelDestino(fila)) ??
      (fila.copropiedadId ?? fila.entidadId)!.toString();

    await this.transaccion(async (session) => {
      await this.escribir(fila, cambios, session);
      await this.auditoria.registrar(
        {
          actorAccountId: actor.accountId,
          actorNombre: actor.nombre,
          accion: reactivando
            ? 'crear'
            : desactivando
              ? 'retirar'
              : 'actualizar',
          entidadTipo: 'usuario',
          entidadId: cuenta._id.toString(),
          entidadEtiqueta: this.etiqueta(
            cuenta.nombreCompleto,
            fila.alcance,
            nombreDestino,
          ),
          detalle,
        },
        session,
      );
    });
  }
}
