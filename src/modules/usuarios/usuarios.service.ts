// src/modules/usuarios/usuarios.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import { FirebaseUsuariosService } from '../../common/firebase/firebase-usuarios.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type { Usuario as UsuarioContract, Paginado } from '../../contracts';
import { toUsuario } from './usuarios.mapper';
import type { ListarUsuariosDto } from './dto/listar-usuarios.dto';
import type {
  ActualizarUsuarioDto,
  CrearUsuarioDto,
} from './dto/guardar-usuario.dto';
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  permisosDesconocidos,
  permisosVetadosParaPerfil,
  type PerfilAsignacion,
} from '../casl/permisos-catalogo';

/**
 * Rejects a permission list that names keys outside the catalog, or that gives
 * operational staff anything of Finanzas (the hard ceiling). Runs before any
 * side effect, so a refused request leaves nothing half-created.
 */
const exigirPermisosValidos = (
  perfil: PerfilAsignacion,
  permisos: readonly string[] | undefined,
): void => {
  if (!permisos || permisos.length === 0) return;
  const desconocidos = permisosDesconocidos(permisos);
  if (desconocidos.length > 0) {
    throw new BadRequestException(
      `Permisos que no existen: ${desconocidos.join(', ')}`,
    );
  }
  const vetados = permisosVetadosParaPerfil(perfil, permisos);
  if (vetados.length > 0) {
    throw new BadRequestException(
      `El personal operativo no puede tener permisos de Finanzas: ${vetados.join(', ')}`,
    );
  }
};

/** Mongo's unique-index violation (E11000). */
const CLAVE_DUPLICADA = 11000;

/** ObjectId equality where null/undefined both mean "no target". */
const igualId = (
  a: Types.ObjectId | null | undefined,
  b: Types.ObjectId | null,
): boolean => (a == null || b == null ? a == null && b == null : a.equals(b));

/** A Firebase uid an administrator has not yet claimed — see seed-admin.ts. */
const esIdentidadReal = (firebaseUid: string): boolean =>
  !firebaseUid.startsWith('pendiente:');

@Injectable()
export class UsuariosService {
  constructor(
    @InjectModel(Account.name)
    private readonly accounts: Model<AccountDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    private readonly firebaseUsuarios: FirebaseUsuariosService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Lists the platform's ADMINISTRATOR accounts and each one's primary
   * assignment: platform admins and anyone holding an `administrativo`
   * assignment (a legacy row with no profile counts as one) — building
   * administrators and accountants, the only people created on this screen.
   * Operational staff (`personal`) are created and managed by each building
   * in /equipo, and residents (owners and tenants) have an Account too — they
   * sign in to the portal — but no assignment: a roster of every technician
   * and every owner of every building would bury the screen, so both are left
   * out. An account whose assignment was deactivated still shows (it has one),
   * so a deactivated administrator can be found again.
   *
   * Not scoped by TenantContextService, same as Entidades/Copropiedades: this
   * is the platform's whole staff roster, not one building's.
   */
  async findAll(query: ListarUsuariosDto): Promise<Paginado<UsuarioContract>> {
    const conAsignacion = await this.asignaciones
      .distinct('accountId', { perfil: { $ne: 'personal' } })
      .exec();
    const condiciones: Record<string, unknown>[] = [
      {
        $or: [
          { esAdministradorPlataforma: true },
          { _id: { $in: conAsignacion } },
        ],
      },
    ];

    if (query.estado !== 'todos') {
      condiciones.push({
        estado: query.estado === 'inactivo' ? 'inactive' : 'active',
      });
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      condiciones.push({
        $or: [{ nombreCompleto: patron }, { email: patron }],
      });
    }
    const filtro: Record<string, unknown> = { $and: condiciones };

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [cuentas, total] = await Promise.all([
      this.accounts
        .find(filtro)
        .sort({ nombreCompleto: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .exec(),
      this.accounts.countDocuments(filtro).exec(),
    ]);

    // One query for every assignment involved, then matched in memory —
    // the same batching AccesoService uses, so a page of fifty users costs
    // two round trips, not fifty-one.
    const asignacionesPorCuenta = await this.asignacionesPrimariasDe(
      cuentas.map((c) => c._id),
    );

    return {
      items: cuentas.map((c) =>
        toUsuario(c, asignacionesPorCuenta.get(c._id.toString()) ?? null),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  async findOne(id: string): Promise<UsuarioContract> {
    const cuenta = await this.accounts.findById(id).exec();
    if (!cuenta) {
      throw new NotFoundException(`No se encontró el usuario ${id}`);
    }

    const asignacion = (await this.asignacionesPrimariasDe([cuenta._id])).get(
      cuenta._id.toString(),
    );
    return toUsuario(cuenta, asignacion ?? null);
  }

  /**
   * Provisions a new user: a Firebase sign-in identity, the local Account, and
   * (unless they are a platform administrator) one assignment.
   *
   * Order matters. The Firebase identity is created FIRST, and if anything
   * after that fails, the result is a Firebase user with no Account — which is
   * exactly the "authenticated but powerless" state FirebaseAuthGuard already
   * treats as safe and ordinary. There is no saga to roll it back, and none is
   * needed: the failure mode this ordering produces is inert by construction.
   */
  async create(
    dto: CrearUsuarioDto,
    actor: { accountId: string; nombre: string },
  ): Promise<UsuarioContract> {
    const correo = dto.email.trim().toLowerCase();
    const perfil = dto.perfil ?? 'administrativo';
    exigirPermisosValidos(perfil, dto.permisos);

    const yaExiste = await this.accounts.exists({ email: correo }).exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una cuenta local con el correo ${correo}`,
      );
    }

    const { uid } = await this.firebaseUsuarios.crear({
      email: correo,
      password: dto.password,
      nombre: dto.nombre,
    });

    const cuenta = await this.accounts.create({
      firebaseUid: uid,
      email: correo,
      nombreCompleto: dto.nombre,
      esAdministradorPlataforma: dto.esAdministradorPlataforma ?? false,
      estado: 'active',
    });

    if (!dto.esAdministradorPlataforma && dto.alcance) {
      await this.asignaciones.create({
        accountId: cuenta._id,
        alcance: dto.alcance,
        copropiedadId:
          dto.alcance === 'copropiedad' && dto.copropiedadId
            ? new Types.ObjectId(dto.copropiedadId)
            : null,
        entidadId:
          dto.alcance === 'entidad' && dto.entidadId
            ? new Types.ObjectId(dto.entidadId)
            : null,
        permisos: dto.permisos ?? [],
        perfil,
        estado: 'active',
      });
    }

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'crear',
      entidadTipo: 'usuario',
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: dto.nombre,
    });

    return this.findOne(cuenta._id.toString());
  }

  /**
   * Edits a user. Deactivating one (`estado: 'inactivo'`) disables the
   * Firebase identity too — see FirebaseUsuariosService.establecerHabilitado
   * for why that is an immediate lockout and not a courtesy. There is no
   * delete: identities and assignments are retired, never removed, for the
   * same reason a financial document never is.
   */
  async update(
    id: string,
    dto: ActualizarUsuarioDto,
    actor: { accountId: string; nombre: string },
  ): Promise<UsuarioContract> {
    // Only what the request itself says is checkable here; the combination with
    // the stored profile is checked when the assignment is written.
    if (dto.perfil !== undefined) {
      exigirPermisosValidos(dto.perfil, dto.permisos);
    } else {
      exigirPermisosValidos('administrativo', dto.permisos);
    }

    const cuenta = await this.accounts.findById(id).exec();
    if (!cuenta) {
      throw new NotFoundException(`No se encontró el usuario ${id}`);
    }

    if (dto.nombre !== undefined) cuenta.nombreCompleto = dto.nombre;
    if (dto.esAdministradorPlataforma !== undefined) {
      cuenta.esAdministradorPlataforma = dto.esAdministradorPlataforma;
    }

    // A `pendiente:` account has no real Firebase identity yet to disable —
    // see seed-admin.ts. Skipping the call is safe, not a gap: the local
    // `estado` check in FirebaseAuthGuard is what actually locks such an
    // account out the moment its owner claims it and signs in.
    if (dto.estado !== undefined && esIdentidadReal(cuenta.firebaseUid)) {
      await this.firebaseUsuarios.establecerHabilitado(
        cuenta.firebaseUid,
        dto.estado === 'activo',
      );
    }
    if (dto.estado !== undefined) {
      cuenta.estado = dto.estado === 'activo' ? 'active' : 'inactive';
    }

    if (dto.nuevaPassword && esIdentidadReal(cuenta.firebaseUid)) {
      await this.firebaseUsuarios.actualizarPassword(
        cuenta.firebaseUid,
        dto.nuevaPassword,
      );
    }

    await cuenta.save();

    if (dto.alcance !== undefined) {
      await this.actualizarAsignacionPrimaria(cuenta._id, dto);
    }

    await this.auditoria.registrar({
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'actualizar',
      entidadTipo: 'usuario',
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: cuenta.nombreCompleto,
    });

    return this.findOne(id);
  }

  /**
   * Replaces the primary assignment with one matching the new scope/target, or
   * updates permissions in place when the target did not change.
   *
   * The old grant is deactivated, never deleted, when the target changes —
   * Asignacion carries the same audit law as everywhere else: "who could
   * touch this building last March" has to stay answerable. It is retired only
   * AFTER the new grant is written (reusing an existing row for that target
   * when there is one), so a failure cannot strand the account with no access.
   *
   * Known limitation: the primary is still "newest active by createdAt", and a
   * reactivated row keeps its old createdAt, so with several active rows it may
   * not be the one read back as primary.
   */
  private async actualizarAsignacionPrimaria(
    accountId: Types.ObjectId,
    dto: ActualizarUsuarioDto,
  ): Promise<void> {
    const actual = await this.asignaciones
      .findOne({ accountId, estado: 'active' })
      .sort({ createdAt: -1 })
      .exec();

    const copropiedadId =
      dto.alcance === 'copropiedad' && dto.copropiedadId
        ? new Types.ObjectId(dto.copropiedadId)
        : null;
    const entidadId =
      dto.alcance === 'entidad' && dto.entidadId
        ? new Types.ObjectId(dto.entidadId)
        : null;

    // ObjectId equality, never string equality: @IsMongoId accepts uppercase
    // hex, and the same target spelled differently must not read as a move.
    const mismoObjetivo =
      actual != null &&
      actual.alcance === dto.alcance &&
      (dto.alcance === 'copropiedad'
        ? igualId(actual.copropiedadId, copropiedadId)
        : igualId(actual.entidadId, entidadId));

    // The profile that will apply, and the permissions it will hold: checked
    // against the ceiling before anything is written.
    const perfil: PerfilAsignacion =
      dto.perfil ?? actual?.perfil ?? 'administrativo';
    exigirPermisosValidos(
      perfil,
      dto.permisos ?? (mismoObjetivo ? actual.permisos : []),
    );

    if (mismoObjetivo) {
      // Same target: changing what someone may do there is not the same
      // event as changing WHERE they may do it, and does not need a new row.
      actual.permisos = dto.permisos ?? actual.permisos;
      actual.perfil = perfil;
      await actual.save();
      return;
    }

    const permisos = dto.permisos ?? [];

    // The unique indexes ignore `estado`, so an INACTIVE row for the new target
    // (an earlier A → B → A move, or one created and retired from /equipo)
    // still occupies the slot: reuse it instead of inserting a second one.
    const objetivo = copropiedadId
      ? { copropiedadId }
      : entidadId
        ? { entidadId }
        : null;
    const existente = objetivo
      ? await this.asignaciones
          .findOne({ accountId, alcance: dto.alcance, ...objetivo })
          .exec()
      : null;

    if (existente && actual && existente._id.equals(actual._id)) {
      // Second guard: the lookup found the row we are about to retire, so this
      // is the same target after all. Edit in place; never deactivate it.
      exigirPermisosValidos(perfil, dto.permisos ?? actual.permisos);
      actual.permisos = dto.permisos ?? actual.permisos;
      actual.perfil = perfil;
      await actual.save();
      return;
    }
    if (existente && existente.estado === 'active') {
      // Only an INACTIVE row may be reactivated. An active one for that target
      // (e.g. granted from /equipo, with its own roles) is somebody's live
      // access: rewriting it here would silently change it.
      throw new ConflictException(
        'La persona ya tiene un acceso activo a ese destino: edítalo desde allí',
      );
    }

    // Write the NEW grant first and retire the old one only afterwards, so a
    // failed write can never leave the account with no active access.
    try {
      if (existente) {
        // Scope and target already match: that is what the lookup above keyed on.
        existente.estado = 'active';
        existente.permisos = permisos;
        existente.perfil = perfil;
        // A fresh row carries no roles; a reactivated one must not silently
        // regain those of its earlier life.
        existente.roleIds = [];
        await existente.save();
      } else {
        await this.asignaciones.create({
          accountId,
          alcance: dto.alcance,
          copropiedadId,
          entidadId,
          permisos,
          perfil,
          estado: 'active',
        });
      }
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException(
          'Otra solicitud creó ese acceso al mismo tiempo: vuelve a intentarlo',
        );
      }
      throw error;
    }

    if (actual) {
      actual.estado = 'inactive';
      await actual.save();
    }
  }

  /** The most recent active assignment for each account, keyed by account id. */
  private async asignacionesPrimariasDe(
    accountIds: Types.ObjectId[],
  ): Promise<Map<string, AsignacionDocument>> {
    if (accountIds.length === 0) return new Map();

    const filas = await this.asignaciones
      .find({ accountId: { $in: accountIds }, estado: 'active' })
      .populate('copropiedadId', 'nombre')
      .populate('entidadId', 'nombre')
      .sort({ createdAt: -1 })
      .exec();

    const porCuenta = new Map<string, AsignacionDocument>();
    for (const fila of filas) {
      const clave = fila.accountId.toString();
      // Sorted newest-first: the first one seen per account is the primary.
      if (!porCuenta.has(clave)) porCuenta.set(clave, fila);
    }
    return porCuenta;
  }
}
