// src/common/directorio/directorio.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  Tercero,
  TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import type { Subject } from '../../modules/casl/casl-ability.constants';
import { puedeLeerMateria } from '../../modules/casl/permisos-catalogo';
import { AccesoService } from '../acceso/acceso.service';

/** `personal` works in the building's back office; `residente` holds a unit. */
export type PerfilDestinatario = 'residente' | 'personal';

/** Somebody the system can notify: an active account with a sign-in. */
export interface Destinatario {
  accountId: string;
  email: string;
  nombre: string;
  /**
   * Which side of the product they use, so a producer can point a link at the
   * right screen (`/pqr` for staff, the portal for a resident).
   */
  perfil: PerfilDestinatario;
}

/**
 * Who a notification or announcement of a coproperty reaches.
 *
 * In the system this replaces, the audience came from `Membership` rows
 * ("owners/tenants", "members whose roles can read X"). Here it is derived from
 * what already exists: a resident is an active `Tercero` linked to an account,
 * and staff are the accounts whose assignment resolves — through the same
 * `AccesoService` that guards the routes — to a permission that can read the
 * subject. So the audience can never include someone who could not open the
 * screen the link points at, and revoking access removes them from it too.
 *
 * Only accounts qualify (a person without a sign-in has nowhere to land), and
 * only active ones. A person who is both staff and resident appears in both
 * lists: a producer that targets both audiences must de-duplicate by
 * `accountId`.
 */
@Injectable()
export class DirectorioService {
  constructor(
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly acceso: AccesoService,
  ) {}

  /** The active accounts among `ids`, keyed by id. */
  private async cuentasActivas(
    ids: Types.ObjectId[],
  ): Promise<Map<string, AccountDocument>> {
    if (ids.length === 0) return new Map();
    const encontradas = await this.cuentas
      .find({ _id: { $in: ids }, estado: 'active' })
      .select('email nombreCompleto esAdministradorPlataforma')
      .lean()
      .exec();
    return new Map(encontradas.map((c) => [c._id.toString(), c]));
  }

  private aDestinatario(
    cuenta: Pick<AccountDocument, '_id' | 'email' | 'nombreCompleto'>,
    perfil: PerfilDestinatario,
  ): Destinatario {
    return {
      accountId: cuenta._id.toString(),
      email: cuenta.email,
      nombre: cuenta.nombreCompleto,
      perfil,
    };
  }

  /** Owners and tenants of the coproperty who have a sign-in. */
  async residentes(copropiedadId: Types.ObjectId): Promise<Destinatario[]> {
    const vinculados = await this.terceros
      .find({ copropiedadId, estado: 'active', accountId: { $ne: null } })
      .select('accountId')
      .lean()
      .exec();

    const ids = new Map<string, Types.ObjectId>();
    for (const t of vinculados) {
      if (t.accountId) ids.set(t.accountId.toString(), t.accountId);
    }
    const cuentas = await this.cuentasActivas([...ids.values()]);
    return [...cuentas.values()].map((c) => this.aDestinatario(c, 'residente'));
  }

  /**
   * Staff of the coproperty (a direct assignment, or one on its managing
   * company) whose effective permissions can read `materia`. A platform admin
   * who holds an assignment here always counts.
   */
  async personalQuePuedeLeer(
    copropiedadId: Types.ObjectId,
    materia: Subject,
  ): Promise<Destinatario[]> {
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('entidadId')
      .lean()
      .exec();

    const alcances: Array<Record<string, unknown>> = [
      { alcance: 'copropiedad', copropiedadId },
    ];
    if (copropiedad?.entidadId) {
      alcances.push({ alcance: 'entidad', entidadId: copropiedad.entidadId });
    }
    const candidatas = await this.asignaciones
      .find({ estado: 'active', $or: alcances })
      .select('accountId')
      .lean()
      .exec();

    const ids = new Map<string, Types.ObjectId>();
    for (const a of candidatas) ids.set(a.accountId.toString(), a.accountId);
    const cuentas = await this.cuentasActivas([...ids.values()]);

    const resultado: Destinatario[] = [];
    for (const [id, cuenta] of cuentas) {
      const acceso = await this.acceso.accesoA(id, copropiedadId.toString());
      if (!acceso) continue;
      if (
        cuenta.esAdministradorPlataforma ||
        puedeLeerMateria(acceso.permissions, materia)
      ) {
        resultado.push(this.aDestinatario(cuenta, 'personal'));
      }
    }
    return resultado;
  }

  /**
   * The account behind an email address (a technician who happens to have a
   * sign-in), as a recipient of something about `materia`; null when there is
   * no such account or it should not be notified. Email is stored lowercased.
   */
  async destinatarioPorEmail(
    email: string,
    copropiedadId: Types.ObjectId,
    materia: Subject,
  ): Promise<Destinatario | null> {
    const [cuenta] = await this.cuentas
      .find({ email: email.trim().toLowerCase() })
      .select('_id')
      .lean()
      .exec();
    if (!cuenta) return null;
    return this.destinatarioDe(cuenta._id.toString(), copropiedadId, materia);
  }

  /**
   * One known account (a task's assignee, a PQR's author) as a recipient of
   * something about `materia`, or null when it should not be notified: no
   * account, inactive, no access to the coproperty, or neither able to read the
   * subject nor a resident. Staff wins over resident for somebody who is both.
   */
  async destinatarioDe(
    accountId: string,
    copropiedadId: Types.ObjectId,
    materia: Subject,
  ): Promise<Destinatario | null> {
    if (!Types.ObjectId.isValid(accountId)) return null;
    const cuenta = (
      await this.cuentasActivas([new Types.ObjectId(accountId)])
    ).get(accountId);
    if (!cuenta) return null;

    const acceso = await this.acceso.accesoA(
      accountId,
      copropiedadId.toString(),
    );
    if (!acceso) return null;

    if (
      cuenta.esAdministradorPlataforma ||
      puedeLeerMateria(acceso.permissions, materia)
    ) {
      return this.aDestinatario(cuenta, 'personal');
    }
    return acceso.esResidente ? this.aDestinatario(cuenta, 'residente') : null;
  }
}
