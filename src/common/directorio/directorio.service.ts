// src/common/directorio/directorio.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
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
import { type DestinoCorreo, destinosDeUnidad } from './destinos-correo';

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

/** How a resident holds one particular unit. */
export type RolEnInmueble = 'propietario' | 'arrendatario';

/** A recipient together with the role they hold on the unit being addressed. */
export interface ResidenteDeInmueble extends Destinatario {
  rol: RolEnInmueble;
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
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
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

  /**
   * Current owners and tenants of the coproperty who have a sign-in: a linked
   * Tercero that is the `titularId` or `arrendatarioId` of an active unit here.
   * A former holder stays linked after a sale or lease end, and must stop
   * receiving residents' notices (same rule as `AccesoService` for the portal).
   */
  async residentes(copropiedadId: Types.ObjectId): Promise<Destinatario[]> {
    const vinculados = await this.terceros
      .find({ copropiedadId, estado: 'active', accountId: { $ne: null } })
      .select('_id accountId')
      .lean()
      .exec();
    if (vinculados.length === 0) return [];

    const terceroIds = vinculados.map((t) => t._id);
    const unidades = await this.inmuebles
      .find({
        copropiedadId,
        estado: 'active',
        $or: [
          { titularId: { $in: terceroIds } },
          { arrendatarioId: { $in: terceroIds } },
        ],
      })
      .select('titularId arrendatarioId')
      .lean()
      .exec();
    const titulares = new Set<string>();
    for (const u of unidades) {
      if (u.titularId) titulares.add(u.titularId.toString());
      if (u.arrendatarioId) titulares.add(u.arrendatarioId.toString());
    }

    const ids = new Map<string, Types.ObjectId>();
    for (const t of vinculados) {
      if (t.accountId && titulares.has(t._id.toString())) {
        ids.set(t.accountId.toString(), t.accountId);
      }
    }
    const cuentas = await this.cuentasActivas([...ids.values()]);
    return [...cuentas.values()].map((c) => this.aDestinatario(c, 'residente'));
  }

  /**
   * The people to notify about each of the given units: the account behind the
   * `Tercero` that is the unit's `titularId` (owner) and the one behind its
   * `arrendatarioId` (tenant), each tagged with the role they hold ON THAT UNIT
   * (the same person can own one unit and rent another).
   *
   * Every id of `inmuebleIds` is a key of the result, with `[]` when nobody is
   * reachable: a party without an account, an inactive party or account, or an
   * inactive/foreign unit is omitted instead of failing, because one unit with
   * nobody to tell must never block the others. The lookup is always bounded by
   * `copropiedadId` (unit AND parties), so an id of another coproperty yields
   * nothing. If owner and tenant ever resolve to the same account the owner wins
   * and it is listed once. Three queries however many units are asked for.
   */
  async residentesDeInmuebles(
    copropiedadId: Types.ObjectId,
    inmuebleIds: Types.ObjectId[],
  ): Promise<Map<string, ResidenteDeInmueble[]>> {
    const resultado = new Map<string, ResidenteDeInmueble[]>(
      inmuebleIds.map((id) => [id.toString(), []]),
    );
    if (inmuebleIds.length === 0) return resultado;

    const unidades = await this.inmuebles
      .find({ _id: { $in: inmuebleIds }, copropiedadId, estado: 'active' })
      .select('titularId arrendatarioId')
      .lean()
      .exec();

    const terceroIds = new Map<string, Types.ObjectId>();
    for (const u of unidades) {
      for (const id of [u.titularId, u.arrendatarioId]) {
        if (id) terceroIds.set(id.toString(), id);
      }
    }
    if (terceroIds.size === 0) return resultado;

    const terceros = await this.terceros
      .find({
        _id: { $in: [...terceroIds.values()] },
        copropiedadId,
        estado: 'active',
        accountId: { $ne: null },
      })
      .select('accountId')
      .lean()
      .exec();
    const cuentaDeTercero = new Map<string, Types.ObjectId>();
    for (const t of terceros) {
      if (t.accountId) cuentaDeTercero.set(t._id.toString(), t.accountId);
    }
    const cuentas = await this.cuentasActivas([...cuentaDeTercero.values()]);

    const alcanzable = (terceroId: Types.ObjectId | null | undefined) => {
      const cuentaId = terceroId
        ? cuentaDeTercero.get(terceroId.toString())
        : undefined;
      return cuentaId ? cuentas.get(cuentaId.toString()) : undefined;
    };

    for (const u of unidades) {
      const lista = resultado.get(u._id.toString());
      if (!lista) continue;
      const propietario = alcanzable(u.titularId);
      if (propietario) {
        lista.push({
          ...this.aDestinatario(propietario, 'residente'),
          rol: 'propietario',
        });
      }
      const arrendatario = alcanzable(u.arrendatarioId);
      if (
        arrendatario &&
        arrendatario._id.toString() !== propietario?._id.toString()
      ) {
        lista.push({
          ...this.aDestinatario(arrendatario, 'residente'),
          rol: 'arrendatario',
        });
      }
    }
    return resultado;
  }

  /**
   * The e-mail addresses each of the given units' invoices go to: the `emails`
   * stored on the unit's titular and arrendatario RECORDS, not the sign-ins of
   * accounts (a party with no account is reachable; a login address that is
   * not on the record is not an address). See `destinosDeUnidad` for the
   * rules (owner first, deduplicated, invalid entries skipped).
   *
   * Every id of `inmuebleIds` is a key of the result, with `[]` when nobody
   * can be reached. Both lookups carry `copropiedadId`, so an id or a party of
   * another coproperty yields nothing, and an inactive unit or party
   * contributes nothing (the same filter as `residentesDeInmuebles`). Two
   * queries however many units are asked for.
   */
  async correosDeInmuebles(
    copropiedadId: Types.ObjectId,
    inmuebleIds: Types.ObjectId[],
  ): Promise<Map<string, DestinoCorreo[]>> {
    const resultado = new Map<string, DestinoCorreo[]>(
      inmuebleIds.map((id) => [id.toString(), []]),
    );
    if (inmuebleIds.length === 0) return resultado;

    const unidades = await this.inmuebles
      .find({ _id: { $in: inmuebleIds }, copropiedadId, estado: 'active' })
      .select('titularId arrendatarioId')
      .lean()
      .exec();

    const terceroIds = new Map<string, Types.ObjectId>();
    for (const u of unidades) {
      for (const id of [u.titularId, u.arrendatarioId]) {
        if (id) terceroIds.set(id.toString(), id);
      }
    }
    if (terceroIds.size === 0) return resultado;

    const terceros = await this.terceros
      .find({
        _id: { $in: [...terceroIds.values()] },
        copropiedadId,
        estado: 'active',
      })
      .select('nombre emails')
      .lean()
      .exec();
    const porId = new Map(terceros.map((t) => [t._id.toString(), t]));

    for (const u of unidades) {
      resultado.set(
        u._id.toString(),
        destinosDeUnidad(
          u.titularId ? porId.get(u.titularId.toString()) : null,
          u.arrendatarioId ? porId.get(u.arrendatarioId.toString()) : null,
        ),
      );
    }
    return resultado;
  }

  /**
   * Same as `residentesDeInmuebles` for ONE unit addressed by its `codigo` (exact
   * match, as stored). A code that matches no ACTIVE unit of the coproperty gives
   * `[]`, the same answer as a unit nobody can be reached at.
   */
  async residentesDeInmueble(
    copropiedadId: Types.ObjectId,
    codigoInmueble: string,
  ): Promise<ResidenteDeInmueble[]> {
    const unidad = await this.inmuebles
      .findOne({ copropiedadId, codigo: codigoInmueble, estado: 'active' })
      .select('_id')
      .lean()
      .exec();
    if (!unidad) return [];
    const porUnidad = await this.residentesDeInmuebles(copropiedadId, [
      unidad._id,
    ]);
    return porUnidad.get(unidad._id.toString()) ?? [];
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
