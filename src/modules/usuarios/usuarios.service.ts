// src/modules/usuarios/usuarios.service.ts
import {
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
   * Lists accounts and each one's primary assignment.
   *
   * Not scoped by TenantContextService, same as Entidades/Copropiedades: this
   * is the platform's whole roster, not one building's.
   */
  async findAll(query: ListarUsuariosDto): Promise<Paginado<UsuarioContract>> {
    const filtro: Record<string, unknown> = {};

    if (query.estado !== 'todos') {
      filtro.status = query.estado === 'inactivo' ? 'inactive' : 'active';
    }
    if (query.buscar) {
      const patron = { $regex: escapeRegex(query.buscar), $options: 'i' };
      filtro.$or = [{ fullName: patron }, { email: patron }];
    }

    const pagina = query.pagina ?? 1;
    const porPagina = query.porPagina ?? 50;

    const [cuentas, total] = await Promise.all([
      this.accounts
        .find(filtro)
        .sort({ fullName: 1 })
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
      fullName: dto.nombre,
      isPlatformAdmin: dto.esAdministradorPlataforma ?? false,
      status: 'active',
    });

    if (!dto.esAdministradorPlataforma && dto.alcance) {
      await this.asignaciones.create({
        accountId: cuenta._id,
        scope: dto.alcance,
        coPropertyId: dto.alcance === 'copropiedad' ? dto.copropiedadId : null,
        entidadId: dto.alcance === 'entidad' ? dto.entidadId : null,
        permissions: dto.permisos ?? [],
        status: 'active',
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
    const cuenta = await this.accounts.findById(id).exec();
    if (!cuenta) {
      throw new NotFoundException(`No se encontró el usuario ${id}`);
    }

    if (dto.nombre !== undefined) cuenta.fullName = dto.nombre;
    if (dto.esAdministradorPlataforma !== undefined) {
      cuenta.isPlatformAdmin = dto.esAdministradorPlataforma;
    }

    // A `pendiente:` account has no real Firebase identity yet to disable —
    // see seed-admin.ts. Skipping the call is safe, not a gap: the local
    // `status` check in FirebaseAuthGuard is what actually locks such an
    // account out the moment its owner claims it and signs in.
    if (dto.estado !== undefined && esIdentidadReal(cuenta.firebaseUid)) {
      await this.firebaseUsuarios.establecerHabilitado(
        cuenta.firebaseUid,
        dto.estado === 'activo',
      );
    }
    if (dto.estado !== undefined) {
      cuenta.status = dto.estado === 'activo' ? 'active' : 'inactive';
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
      entidadEtiqueta: cuenta.fullName,
    });

    return this.findOne(id);
  }

  /**
   * Replaces the primary assignment with one matching the new scope/target, or
   * updates permissions in place when the target did not change.
   *
   * The old grant is deactivated, never deleted, when the target changes —
   * Asignacion carries the same audit law as everywhere else: "who could
   * touch this building last March" has to stay answerable.
   */
  private async actualizarAsignacionPrimaria(
    accountId: Types.ObjectId,
    dto: ActualizarUsuarioDto,
  ): Promise<void> {
    const actual = await this.asignaciones
      .findOne({ accountId, status: 'active' })
      .sort({ createdAt: -1 })
      .exec();

    const mismoObjetivo =
      actual != null &&
      actual.scope === dto.alcance &&
      (dto.alcance === 'copropiedad'
        ? actual.coPropertyId?.toString() === dto.copropiedadId
        : actual.entidadId?.toString() === dto.entidadId);

    if (mismoObjetivo) {
      // Same target: changing what someone may do there is not the same
      // event as changing WHERE they may do it, and does not need a new row.
      actual.permissions = dto.permisos ?? actual.permissions;
      await actual.save();
      return;
    }

    if (actual) {
      actual.status = 'inactive';
      await actual.save();
    }

    await this.asignaciones.create({
      accountId,
      scope: dto.alcance,
      coPropertyId: dto.alcance === 'copropiedad' ? dto.copropiedadId : null,
      entidadId: dto.alcance === 'entidad' ? dto.entidadId : null,
      permissions: dto.permisos ?? [],
      status: 'active',
    });
  }

  /** The most recent active assignment for each account, keyed by account id. */
  private async asignacionesPrimariasDe(
    accountIds: Types.ObjectId[],
  ): Promise<Map<string, AsignacionDocument>> {
    if (accountIds.length === 0) return new Map();

    const filas = await this.asignaciones
      .find({ accountId: { $in: accountIds }, status: 'active' })
      .populate('coPropertyId', 'name')
      .populate('entidadId', 'name')
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
