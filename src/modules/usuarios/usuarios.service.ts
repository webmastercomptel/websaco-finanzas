// src/modules/usuarios/usuarios.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
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
import { cambioDeClaves, exigirClavesConocidas } from '../casl/delegacion';
import { AsignacionesUsuarioService } from './asignaciones-usuario.service';

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
    private readonly asignacionesUsuario: AsignacionesUsuarioService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Same shape as the other transactional services: `withTransaction` may
   * re-run the callback on a transient error, so what it does must be safe to
   * repeat (the insert fails on the unique index, the audit entry is rolled back
   * with it).
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

  /**
   * Lists the platform's ADMINISTRATOR accounts with every assignment they
   * hold (`asignaciones`): platform admins and anyone holding an `administrativo`
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

    // One query for every row of every account of the page, then matched in
    // memory — the same batching AccesoService uses, so a page of fifty users
    // costs two round trips, not fifty-one.
    const filasPorCuenta = await this.filasDe(cuentas.map((c) => c._id));

    return {
      items: cuentas.map((c) =>
        toUsuario(c, filasPorCuenta.get(c._id.toString()) ?? []),
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

    const filas = (await this.filasDe([cuenta._id])).get(cuenta._id.toString());
    return toUsuario(cuenta, filas ?? []);
  }

  /**
   * Provisions a new user: a Firebase sign-in identity, the local Account, and
   * (unless they are a platform administrator) their FIRST assignment, which is
   * mandatory: "created with no assignment" is indistinguishable from "created
   * and then forgotten".
   *
   * Order matters. Everything that can be refused is refused first (the keys
   * must be offered, the assignment must name a target that exists), so a refused request
   * leaves nothing behind. The Firebase identity is created NEXT, then the
   * Account; if anything after that fails, the result is an identity or an
   * account with no assignment — exactly the "authenticated but powerless"
   * state FirebaseAuthGuard already treats as safe and ordinary. There is no
   * saga to roll it back, and none is needed: the failure mode this ordering
   * produces is inert by construction, and the retry meets the existing-email
   * 409 instead of creating a second identity.
   *
   * The assignment and its audit entry (with `detalle`) are written in ONE
   * Mongo transaction, so a failed audit write leaves no row behind. A platform
   * administrator has no assignment: its entry carries no `detalle`.
   */
  async create(
    dto: CrearUsuarioDto,
    actor: { accountId: string; nombre: string },
  ): Promise<UsuarioContract> {
    const correo = dto.email.trim().toLowerCase();
    const permisos = dto.permisos ?? [];
    // Every key here is NEW, so each must be offered: a grammar-valid key that
    // no route checks (`inmuebles.aprobar`) would be stored with no trace in
    // `detalle`.
    exigirClavesConocidas(permisos);

    const yaExiste = await this.accounts.exists({ email: correo }).exec();
    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una cuenta local con el correo ${correo}`,
      );
    }

    // Still before Firebase: a request with no target, or one naming a target
    // that does not exist, creates nothing.
    const asignacion = dto.esAdministradorPlataforma
      ? null
      : await this.destinoDeLaPrimeraAsignacion(dto);

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

    const entrada = {
      actorAccountId: actor.accountId,
      actorNombre: actor.nombre,
      accion: 'crear' as const,
      entidadTipo: 'usuario' as const,
      entidadId: cuenta._id.toString(),
      entidadEtiqueta: dto.nombre,
    };

    if (asignacion) {
      await this.transaccion(async (session) => {
        await this.asignacionesUsuario.insertar(
          { accountId: cuenta._id, ...asignacion, permisos },
          session,
        );
        await this.auditoria.registrar(
          { ...entrada, detalle: cambioDeClaves([], permisos) },
          session,
        );
      });
    } else {
      await this.auditoria.registrar(entrada);
    }

    return this.findOne(cuenta._id.toString());
  }

  /**
   * The target of the first assignment, as the ObjectIds the unique indexes key
   * on: 400 when the request does not name one or names a malformed id, 404 when
   * it names one that does not exist (the same rule and messages as
   * `POST /usuarios/:id/asignaciones`, through `resolverDestino`). The DTO
   * already demands the fields; this keeps the rules true for any caller, and
   * BEFORE Firebase is touched, so a refused request leaves no identity behind.
   */
  private async destinoDeLaPrimeraAsignacion(dto: CrearUsuarioDto): Promise<{
    alcance: 'copropiedad' | 'entidad';
    copropiedadId: Types.ObjectId | null;
    entidadId: Types.ObjectId | null;
  }> {
    const nombraDestino =
      (dto.alcance === 'copropiedad' && dto.copropiedadId) ||
      (dto.alcance === 'entidad' && dto.entidadId);
    if (!nombraDestino) {
      throw new BadRequestException(
        'Indica a dónde tendrá acceso: una copropiedad o una entidad administradora',
      );
    }
    const { alcance, copropiedadId, entidadId } =
      await this.asignacionesUsuario.resolverDestino(dto);
    return { alcance, copropiedadId, entidadId };
  }

  /**
   * Edits a user's ACCOUNT: name, platform-admin flag, state and password. It
   * never reads or writes an assignment row (those are managed one at a time by
   * `AsignacionesUsuarioService`), so a save cannot replace, move or retire any
   * of them. Deactivating the account (`estado: 'inactivo'`) disables the
   * Firebase identity too — see FirebaseUsuariosService.establecerHabilitado
   * for why that is an immediate lockout and not a courtesy: it is the switch
   * over every row, which keep their own `estado`. There is no delete:
   * identities and assignments are retired, never removed, for the same reason
   * a financial document never is.
   */
  async update(
    id: string,
    dto: ActualizarUsuarioDto,
    actor: { accountId: string; nombre: string },
  ): Promise<UsuarioContract> {
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
   * EVERY row of each account, active and inactive, of any profile, keyed by
   * account id and oldest first (ties by id): the whole of `asignaciones`.
   */
  private async filasDe(
    accountIds: Types.ObjectId[],
  ): Promise<Map<string, AsignacionDocument[]>> {
    if (accountIds.length === 0) return new Map();

    const filas = await this.asignaciones
      .find({ accountId: { $in: accountIds } })
      .populate('copropiedadId', 'nombre')
      .populate('entidadId', 'nombre')
      .sort({ createdAt: 1, _id: 1 })
      .exec();

    const porCuenta = new Map<string, AsignacionDocument[]>();
    for (const fila of filas) {
      const clave = fila.accountId.toString();
      const lista = porCuenta.get(clave);
      if (lista) lista.push(fila);
      else porCuenta.set(clave, [fila]);
    }
    return porCuenta;
  }
}
