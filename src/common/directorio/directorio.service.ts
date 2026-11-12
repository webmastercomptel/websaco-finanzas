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
import { correoProbado } from '../acceso/residencia.reglas';
import { ResidenciaService } from '../acceso/residencia.service';
import { claveCorreo, normalizarEmail } from '../utils/email.utils';
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
    private readonly residencia: ResidenciaService,
  ) {}

  /**
   * The active accounts among `ids`, keyed by id. `correoProbadoClave` is
   * read too, so the account can be handed to `AccesoService.accesoA` and the
   * access derivation re-reads nothing.
   */
  private async cuentasActivas(
    ids: Types.ObjectId[],
  ): Promise<Map<string, AccountDocument>> {
    if (ids.length === 0) return new Map();
    const encontradas = await this.cuentas
      .find({ _id: { $in: ids }, estado: 'active' })
      .select(
        'email nombreCompleto esAdministradorPlataforma correoProbadoClave',
      )
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
   * The ACTIVE accounts behind each of these parties, keyed by party id, by the
   * same two routes as the portal (`AccesoService`/`PortalAccesoService`):
   * the legacy link (`Tercero.accountId`) and an account that PROVED an
   * address carried by the party's record (`correoProbado`, exact match of the
   * stored value: a padded legacy address is not a candidate). An account whose
   * address has an active revocation in this coproperty is dropped on BOTH
   * routes. A proven address that is a generic inbox (`motivoCorreoGenerico`)
   * reaches nobody by the address route. Queries: accounts by id, accounts by
   * proven address (only when some party carries an address), the generic-inbox
   * batch (only when some account proved one) and one batch of revocations,
   * however many parties are asked for.
   */
  private async cuentasDePartes(
    copropiedadId: Types.ObjectId,
    partes: Array<{
      _id: Types.ObjectId;
      accountId?: Types.ObjectId | null;
      emails?: string[] | null;
    }>,
  ): Promise<Map<string, AccountDocument[]>> {
    const porParte = new Map<string, AccountDocument[]>();

    // One account may be linked to several parties: ask for it once.
    const idsHeredados = new Map<string, Types.ObjectId>();
    for (const p of partes) {
      if (p.accountId) idsHeredados.set(p.accountId.toString(), p.accountId);
    }
    const heredadas = await this.cuentasActivas([...idsHeredados.values()]);

    // Exact stored values only (`coincideCorreo`: no padding), lowercased.
    const direccionesDe = (p: { emails?: string[] | null }): string[] =>
      (p.emails ?? [])
        .filter((e) => e.length > 0 && e === e.trim())
        .map((e) => normalizarEmail(e));
    const direcciones = [...new Set(partes.flatMap(direccionesDe))];
    const probadas = new Map<string, AccountDocument>();
    if (direcciones.length > 0) {
      const candidatas = await this.cuentas
        .find({
          email: { $in: direcciones },
          estado: 'active',
          correoProbadoClave: { $ne: null },
        })
        .select(
          'email nombreCompleto esAdministradorPlataforma correoProbadoClave',
        )
        .lean()
        .exec();
      for (const c of candidatas) {
        if (correoProbado(c)) probadas.set(c.email, c);
      }
    }
    // A generic inbox derives no residency (`motivoCorreoGenerico`, the same
    // rule as the portal): only the proven route is cut, the legacy link stays.
    if (probadas.size > 0) {
      const genericos = await this.residencia.motivosCorreoGenerico([
        ...probadas.keys(),
      ]);
      for (const correo of genericos.keys()) probadas.delete(correo);
    }

    for (const p of partes) {
      const cuentas = new Map<string, AccountDocument>();
      const heredada = p.accountId
        ? heredadas.get(p.accountId.toString())
        : undefined;
      if (heredada) cuentas.set(heredada._id.toString(), heredada);
      for (const direccion of direccionesDe(p)) {
        const probada = probadas.get(direccion);
        if (probada) cuentas.set(probada._id.toString(), probada);
      }
      if (cuentas.size > 0) {
        porParte.set(p._id.toString(), [...cuentas.values()]);
      }
    }

    const claves = new Map<string, string>();
    for (const cuentas of porParte.values()) {
      for (const c of cuentas) {
        claves.set(c._id.toString(), claveCorreo(c.email));
      }
    }
    const revocadas = await this.residencia.clavesRevocadas(
      [...new Set(claves.values())],
      copropiedadId.toString(),
    );
    if (revocadas.size > 0) {
      for (const [parteId, cuentas] of [...porParte]) {
        const vigentes = cuentas.filter(
          (c) => !revocadas.has(claves.get(c._id.toString()) ?? ''),
        );
        if (vigentes.length > 0) porParte.set(parteId, vigentes);
        else porParte.delete(parteId);
      }
    }
    return porParte;
  }

  /**
   * Current owners and tenants of the coproperty who can sign in: an active
   * account that is a resident by the portal's own derivation, either linked
   * to a party (`Tercero.accountId`) or having proved an address on the record
   * of a party that is the `titularId` or `arrendatarioId` of an active unit
   * here, and with no active revocation of that address in this coproperty.
   * A former holder stays linked after a sale or lease end, and must stop
   * receiving residents' notices (same rule as `AccesoService` for the portal).
   * Each account is listed once.
   */
  async residentes(copropiedadId: Types.ObjectId): Promise<Destinatario[]> {
    const partes = await this.terceros
      .find({ copropiedadId, estado: 'active' })
      .select('_id accountId emails')
      .lean()
      .exec();
    if (partes.length === 0) return [];

    const terceroIds = partes.map((t) => t._id);
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

    const cuentas = await this.cuentasDePartes(
      copropiedadId,
      partes.filter((t) => titulares.has(t._id.toString())),
    );
    const unicas = new Map<string, AccountDocument>();
    for (const lista of cuentas.values()) {
      for (const c of lista) unicas.set(c._id.toString(), c);
    }
    return [...unicas.values()].map((c) => this.aDestinatario(c, 'residente'));
  }

  /**
   * The people to notify about each of the given units: the account behind the
   * `Tercero` that is the unit's `titularId` (owner) and the one behind its
   * `arrendatarioId` (tenant), each tagged with the role they hold ON THAT UNIT
   * (the same person can own one unit and rent another).
   *
   * Accounts are found by the same two routes as the portal
   * (`cuentasDePartes`): the legacy link and a proven address on the party's
   * record, minus the addresses revoked in this coproperty.
   *
   * Every id of `inmuebleIds` is a key of the result, with `[]` when nobody is
   * reachable: a party without an account, an inactive party or account, a
   * revoked address, or an inactive/foreign unit is omitted instead of failing,
   * because one unit with nobody to tell must never block the others. The
   * lookup is always bounded by `copropiedadId` (unit AND parties), so an id of
   * another coproperty yields nothing. If owner and tenant ever resolve to the
   * same account the owner wins and it is listed once. A constant number of
   * queries however many units are asked for (units, parties, accounts by id,
   * accounts by proven address, revocations).
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
      })
      .select('accountId emails')
      .lean()
      .exec();
    const cuentasDeParte = await this.cuentasDePartes(copropiedadId, terceros);

    const alcanzables = (terceroId: Types.ObjectId | null | undefined) =>
      terceroId ? (cuentasDeParte.get(terceroId.toString()) ?? []) : [];

    for (const u of unidades) {
      const lista = resultado.get(u._id.toString());
      if (!lista) continue;
      // Several addresses of one party are several accounts. If the owner and
      // the tenant resolve to the same account, the owner wins.
      const propietarios = alcanzables(u.titularId);
      for (const c of propietarios) {
        lista.push({
          ...this.aDestinatario(c, 'residente'),
          rol: 'propietario',
        });
      }
      const yaEstan = new Set(propietarios.map((c) => c._id.toString()));
      for (const c of alcanzables(u.arrendatarioId)) {
        if (yaEstan.has(c._id.toString())) continue;
        lista.push({
          ...this.aDestinatario(c, 'residente'),
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
      const acceso = await this.acceso.accesoA(
        id,
        copropiedadId.toString(),
        false,
        { email: cuenta.email, correoProbadoClave: cuenta.correoProbadoClave },
      );
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
      false,
      { email: cuenta.email, correoProbadoClave: cuenta.correoProbadoClave },
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
