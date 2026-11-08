// src/modules/acceso-residentes/acceso-residentes.service.ts
import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FirebaseUsuariosService } from '../../common/firebase/firebase-usuarios.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type {
  AccesoResidenteCreado,
  AprovisionamientoResidentes,
  Paginado,
  ResidenteAcceso,
  ResultadoInvitacion,
  UnidadDeResidente,
} from '../../contracts';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
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
import { AuditoriaService } from '../auditoria/auditoria.service';
import {
  correoDeInvitacion,
  toResidenteAcceso,
  type TerceroResidente,
} from './acceso-residentes.mapper';
import type { AprovisionarResidentesDto } from './dto/aprovisionar-residentes.dto';
import { MAX_APROVISIONAMIENTO } from './dto/aprovisionar-residentes.dto';
import type { CrearAccesoResidenteDto } from './dto/crear-acceso-residente.dto';
import type { ListarResidentesDto } from './dto/listar-residentes.dto';
import { InvitacionAccesoService } from './invitacion-acceso.service';
import { CODIGO_CUENTA_EXISTENTE } from '../../common/firebase/codigos-cuenta';

/** Mongo's duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

/**
 * How many parties are provisioned at once inside a bulk page. Each one costs a
 * Firebase call, several Mongo writes and an email, and the identity pool is
 * shared with another system, so the burst is kept small.
 */
export const APROVISIONAMIENTOS_SIMULTANEOS = 5;

/** A party as this service reads it (always `.lean()`). */
interface TerceroLean extends TerceroResidente {
  _id: Types.ObjectId;
  accountId?: Types.ObjectId | null;
}

/** What `procesar` did for one party. */
interface AccesoProcesado extends ResultadoInvitacion {
  accountId: Types.ObjectId;
  cuentaExistente: boolean;
}

/**
 * Bulk provisioning NEVER links an account that already exists; it reports the
 * party as skipped. A private error type, so the page loop can tell "skipped on
 * purpose" from "failed" without parsing messages.
 */
class CuentaExistenteOmitida extends Error {}

/** Human-readable reason for a row error; unexpected errors never leak their text. */
const mensajeDe = (error: unknown): string =>
  error instanceof HttpException
    ? error.message
    : 'Error inesperado al crear el acceso';

/**
 * Gives owners and tenants a sign-in to the portal.
 *
 * Residents already exist as `Tercero` (holders of `Inmueble.titularId` /
 * `arrendatarioId`); this module provisions an `Account` for one and links it
 * through `Tercero.accountId`. It creates NO `Asignacion`: what a resident can
 * see is derived from that link by `AccesoService`/`PortalAccesoService`, so
 * unlinking removes the access with nothing else to clean up.
 *
 * Security shape, in short:
 * - Every lookup filters by id AND the active coproperty; a party of another
 *   building is a 404.
 * - The address comes only from the party's own record (see
 *   `CrearAccesoResidenteDto`).
 * - An existing account is never taken over silently. One party, one explicit
 *   `vincularExistente`, and never an account that holds any `Asignacion` or is
 *   a platform administrator (linking would hand a staff member a resident view
 *   they did not ask for, decided by someone else).
 * - Firebase is only reached through `FirebaseUsuariosService`, with a random
 *   password nobody sees; unlinking never disables or removes the identity.
 *
 * No transaction spans Firebase and Mongo, so the order is chosen so every
 * partial failure is inert and recoverable: identity first, then Account, then
 * the link. A failure after the Account exists leaves a powerless account with
 * no link; the single-party endpoint with `vincularExistente` finishes the job.
 * A failure right after the identity exists makes a retry meet Firebase's
 * "email already exists" 409, reported per row — never a second identity.
 */
@Injectable()
export class AccesoResidentesService {
  private readonly logger = new Logger(AccesoResidentesService.name);

  constructor(
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    private readonly firebaseUsuarios: FirebaseUsuariosService,
    private readonly tenant: TenantContextService,
    private readonly invitaciones: InvitacionAccesoService,
    private readonly auditoria: AuditoriaService,
  ) {}

  /**
   * Units of the active coproperty that have a holder, keyed by the holder's
   * party id. One query however many units: the coproperty is bounded (hundreds
   * of units), and both the listing and the bulk run need the whole map.
   */
  private async unidadesPorTercero(
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, UnidadDeResidente[]>> {
    const unidades = await this.inmuebles
      .find({
        copropiedadId,
        estado: 'active',
        $or: [{ titularId: { $ne: null } }, { arrendatarioId: { $ne: null } }],
      })
      .select('codigo titularId arrendatarioId')
      .sort({ codigo: 1 })
      .lean()
      .exec();

    const mapa = new Map<string, UnidadDeResidente[]>();
    const agregar = (
      terceroId: Types.ObjectId | null | undefined,
      u: { _id: Types.ObjectId; codigo: string },
      rol: UnidadDeResidente['rol'],
    ): void => {
      if (!terceroId) return;
      const clave = terceroId.toString();
      const lista = mapa.get(clave) ?? [];
      lista.push({ inmuebleId: u._id.toString(), codigo: u.codigo, rol });
      mapa.set(clave, lista);
    };
    for (const u of unidades) {
      agregar(u.titularId, u, 'propietario');
      agregar(u.arrendatarioId, u, 'arrendatario');
    }
    return mapa;
  }

  /** The party of the ACTIVE coproperty, or 404: a foreign or malformed id is "not found". */
  private async cargarTercero(
    id: string,
    copropiedadId: Types.ObjectId,
  ): Promise<TerceroLean> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Tercero ${id} no encontrado`);
    }
    const tercero = await this.terceros
      .findOne({ _id: new Types.ObjectId(id), copropiedadId, estado: 'active' })
      .select('nombre emails accountId')
      .lean()
      .exec();
    if (!tercero) throw new NotFoundException(`Tercero ${id} no encontrado`);
    return tercero;
  }

  /** `entidadEtiqueta` of the audit entries: names the party and the building. */
  private etiqueta(nombre: string, copropiedadId: Types.ObjectId): string {
    return `Acceso de residente: ${nombre} (copropiedad ${copropiedadId.toString()})`;
  }

  /**
   * Owners and tenants of the coproperty with their unit(s), role per unit and
   * whether they can sign in. Only parties that actually hold an active unit
   * are listed: that is who the portal is for.
   */
  async listar(
    filtros: ListarResidentesDto,
  ): Promise<Paginado<ResidenteAcceso>> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const unidades = await this.unidadesPorTercero(copropiedadId);

    const condiciones: Record<string, unknown>[] = [
      {
        _id: { $in: [...unidades.keys()].map((id) => new Types.ObjectId(id)) },
      },
    ];
    if (filtros.estadoAcceso === 'sinCuenta') {
      condiciones.push({ accountId: null });
    } else if (filtros.estadoAcceso === 'conCuenta') {
      condiciones.push({ accountId: { $ne: null } });
    }
    if (filtros.buscar) {
      const patron = { $regex: escapeRegex(filtros.buscar), $options: 'i' };
      const buscado = filtros.buscar.toLowerCase();
      const porCodigo = [...unidades.entries()]
        .filter(([, lista]) =>
          lista.some((u) => u.codigo.toLowerCase().includes(buscado)),
        )
        .map(([id]) => new Types.ObjectId(id));
      condiciones.push({
        $or: [
          { nombre: patron },
          { emails: patron },
          { _id: { $in: porCodigo } },
        ],
      });
    }
    const filtro = {
      copropiedadId,
      estado: 'active' as const,
      $and: condiciones,
    };

    const pagina = filtros.pagina ?? 1;
    const porPagina = filtros.porPagina ?? 50;
    const [filas, total] = await Promise.all([
      this.terceros
        .find(filtro)
        .select('nombre emails accountId')
        .sort({ nombre: 1, _id: 1 })
        .skip((pagina - 1) * porPagina)
        .limit(porPagina)
        .lean()
        .exec(),
      this.terceros.countDocuments(filtro).exec(),
    ]);

    const cuentaIds = filas
      .map((t) => t.accountId)
      .filter((id): id is Types.ObjectId => id != null);
    const estados = new Map<string, boolean>();
    if (cuentaIds.length > 0) {
      const cuentas = await this.cuentas
        .find({ _id: { $in: cuentaIds } })
        .select('estado')
        .lean()
        .exec();
      for (const c of cuentas)
        estados.set(c._id.toString(), c.estado === 'active');
    }

    return {
      items: filas.map((t) =>
        toResidenteAcceso(
          t as TerceroLean,
          unidades.get(t._id.toString()) ?? [],
          t.accountId ? (estados.get(t.accountId.toString()) ?? false) : null,
        ),
      ),
      total,
      pagina,
      porPagina,
    };
  }

  /**
   * Creates (or, on explicit consent, links) the sign-in of ONE party.
   * See the class docblock for the rules about existing accounts.
   */
  async crearAcceso(
    terceroId: string,
    dto: CrearAccesoResidenteDto,
    user: IRequestUser,
  ): Promise<AccesoResidenteCreado> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const tercero = await this.cargarTercero(terceroId, copropiedadId);
    const resultado = await this.procesar(
      tercero,
      copropiedadId,
      { vincularExistente: dto.vincularExistente === true, masivo: false },
      user,
    );
    return {
      terceroId: tercero._id.toString(),
      cuentaExistente: resultado.cuentaExistente,
      invitacionEnviada: resultado.invitacionEnviada,
      enlaceIncluido: resultado.enlaceIncluido,
    };
  }

  /**
   * The shared core of the single and bulk flows: resolve the account (create
   * or, only when allowed, reuse), link it to the party, audit, invite.
   */
  private async procesar(
    tercero: TerceroLean,
    copropiedadId: Types.ObjectId,
    opciones: { vincularExistente: boolean; masivo: boolean },
    user: IRequestUser,
  ): Promise<AccesoProcesado> {
    if (tercero.accountId) {
      throw new ConflictException('Este tercero ya tiene acceso al portal');
    }
    const correo = correoDeInvitacion(tercero.emails);
    if (!correo) {
      throw new ConflictException(
        'El tercero no tiene un correo válido: agrégalo en Terceros antes de dar acceso',
      );
    }

    const existente = await this.cuentas.findOne({ email: correo }).exec();
    let cuenta: AccountDocument;
    let cuentaExistente = false;

    if (existente) {
      if (opciones.masivo) {
        throw new CuentaExistenteOmitida(
          'Ya existe una cuenta con ese correo: se vincula de a un tercero, con confirmación',
        );
      }
      if (!opciones.vincularExistente) {
        throw new ConflictException({
          code: CODIGO_CUENTA_EXISTENTE,
          message:
            'Ya existe una cuenta con el correo del tercero. Si es la misma persona, confirma el vínculo con vincularExistente',
        });
      }
      await this.exigirCuentaVinculable(existente, tercero, copropiedadId);
      cuenta = existente;
      cuentaExistente = true;
    } else {
      // Random and never shown: the person gets in through the invitation link
      // and picks their own password. Nobody, including this process after the
      // call, can read it back.
      const { uid } = await this.firebaseUsuarios.crear({
        email: correo,
        password: randomBytes(32).toString('base64url'),
        nombre: tercero.nombre,
      });
      try {
        cuenta = await this.cuentas.create({
          firebaseUid: uid,
          email: correo,
          nombreCompleto: tercero.nombre,
          esAdministradorPlataforma: false,
          estado: 'active',
        });
      } catch (error: unknown) {
        if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
          throw new ConflictException(
            'Otra solicitud creó la cuenta de ese correo al mismo tiempo: vuelve a intentarlo',
          );
        }
        throw error;
      }
    }

    await this.vincular(tercero._id, cuenta._id, copropiedadId);

    try {
      await this.auditoria.registrar({
        actorAccountId: user.accountId!,
        actorNombre: user.nombre ?? user.email,
        accion: 'crear',
        entidadTipo: 'usuario',
        entidadId: cuenta._id.toString(),
        entidadEtiqueta: this.etiqueta(tercero.nombre, copropiedadId),
      });
    } catch (error: unknown) {
      // The access already exists; failing the row now would only make the
      // retry skip it (it is linked) and lose the entry for good. Loud, not fatal.
      this.logger.error(
        `El acceso del tercero ${tercero._id.toString()} se creó pero no se pudo auditar: ${(error as Error).message}`,
      );
    }

    const invitacion = await this.invitaciones.enviar({
      accountId: cuenta._id.toString(),
      email: cuenta.email,
      nombre: tercero.nombre,
      copropiedadId,
      tipo: 'residente',
      cuentaExistente,
      destino: '/portal',
    });
    return { accountId: cuenta._id, cuentaExistente, ...invitacion };
  }

  /**
   * An existing account may become a resident only if it has no power of its
   * own: linking exposes the unit's invoices through the portal, and for a staff
   * member or platform administrator that is a side effect somebody else would
   * be deciding for them.
   */
  private async exigirCuentaVinculable(
    cuenta: AccountDocument,
    tercero: TerceroLean,
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    if (cuenta.esAdministradorPlataforma) {
      throw new ConflictException(
        'Esa cuenta es de un administrador de la plataforma y no puede vincularse como residente',
      );
    }
    if (cuenta.estado !== 'active') {
      throw new ConflictException(
        'Esa cuenta está inactiva: solo la administración de la plataforma puede reactivarla',
      );
    }
    const esPersonal = await this.asignaciones
      .exists({ accountId: cuenta._id })
      .exec();
    if (esPersonal) {
      throw new ConflictException(
        'Esa cuenta pertenece a personal de una copropiedad y no puede vincularse como residente desde aquí',
      );
    }
    const otro = await this.terceros
      .exists({
        copropiedadId,
        accountId: cuenta._id,
        _id: { $ne: tercero._id },
      })
      .exec();
    if (otro) {
      throw new ConflictException(
        'Esa cuenta ya está vinculada a otro tercero de esta copropiedad',
      );
    }
  }

  /**
   * Writes the link with a conditional update (`accountId: null`), so two
   * concurrent requests can never both win, and the partial unique index
   * `{copropiedadId, accountId}` has the last word on the account side.
   */
  private async vincular(
    terceroId: Types.ObjectId,
    accountId: Types.ObjectId,
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    try {
      const res = await this.terceros
        .updateOne(
          { _id: terceroId, copropiedadId, estado: 'active', accountId: null },
          { $set: { accountId } },
        )
        .exec();
      if (res.matchedCount === 0) {
        throw new ConflictException(
          'El tercero cambió mientras se procesaba: revisa su estado y vuelve a intentarlo',
        );
      }
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException(
          'Esa cuenta ya está vinculada a otro tercero de esta copropiedad',
        );
      }
      throw error;
    }
  }

  /**
   * Re-sends the invitation to a party that already has a sign-in. It goes to
   * the ACCOUNT's own address, never to whatever the party's record says today,
   * so editing a Tercero's email cannot redirect somebody else's sign-in link.
   */
  async reenviarInvitacion(terceroId: string): Promise<ResultadoInvitacion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const tercero = await this.cargarTercero(terceroId, copropiedadId);
    if (!tercero.accountId) {
      throw new ConflictException('Este tercero todavía no tiene acceso');
    }
    const cuenta = await this.cuentas.findById(tercero.accountId).exec();
    if (!cuenta || cuenta.estado !== 'active') {
      throw new ConflictException(
        'La cuenta de este tercero está inactiva: no se puede invitar',
      );
    }
    return this.invitaciones.enviar({
      accountId: cuenta._id.toString(),
      email: cuenta.email,
      nombre: tercero.nombre,
      copropiedadId,
      tipo: 'residente',
      cuentaExistente: false,
      destino: '/portal',
    });
  }

  /**
   * Removes the party's portal access by clearing the link. The Account and the
   * Firebase identity are left alone on purpose: the same person may be staff
   * or a resident of another building, and accounts are never deleted.
   */
  async desvincular(
    terceroId: string,
    user: IRequestUser,
  ): Promise<{ id: string }> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const tercero = await this.cargarTercero(terceroId, copropiedadId);
    if (!tercero.accountId) {
      throw new ConflictException('Este tercero no tiene acceso al portal');
    }
    const accountId = tercero.accountId;
    const res = await this.terceros
      .updateOne(
        { _id: tercero._id, copropiedadId, accountId },
        { $set: { accountId: null } },
      )
      .exec();
    if (res.matchedCount === 0) {
      throw new ConflictException(
        'El tercero cambió mientras se procesaba: vuelve a intentarlo',
      );
    }
    await this.auditoria.registrar({
      actorAccountId: user.accountId!,
      actorNombre: user.nombre ?? user.email,
      accion: 'retirar',
      entidadTipo: 'usuario',
      entidadId: accountId.toString(),
      entidadEtiqueta: this.etiqueta(tercero.nombre, copropiedadId),
    });
    return { id: tercero._id.toString() };
  }

  /**
   * One page of the bulk run: parties that hold an active unit, have no account
   * and a usable address. It replaces the source system's spreadsheet import
   * (units and parties are loaded by the Inmuebles import).
   *
   * Resumable and idempotent. The page is cut by a cursor on the party id, so a
   * party that is skipped or fails never comes back inside the same run (a
   * "pending" counter that depends on rows that cannot succeed would never
   * reach 0); a NEW run starts without a cursor and retries them. Whatever was
   * created is linked, so a retry after a cut-off does not select it again; a
   * party whose identity was created but not saved locally surfaces as
   * Firebase's per-row 409, never as a second identity.
   *
   * It never links an account that already exists: those are reported as
   * skipped. Parties sharing an address are processed one after another
   * (the second finds the account the first just made), different addresses at
   * `APROVISIONAMIENTOS_SIMULTANEOS` at a time.
   */
  async aprovisionar(
    dto: AprovisionarResidentesDto,
    user: IRequestUser,
  ): Promise<AprovisionamientoResidentes> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const limite = Math.min(
      dto.limite ?? MAX_APROVISIONAMIENTO,
      MAX_APROVISIONAMIENTO,
    );
    const unidades = await this.unidadesPorTercero(copropiedadId);

    const idFiltro: Record<string, unknown> = {
      $in: [...unidades.keys()].map((id) => new Types.ObjectId(id)),
    };
    if (dto.desde) idFiltro.$gt = new Types.ObjectId(dto.desde);

    const candidatos = (await this.terceros
      .find({ _id: idFiltro, copropiedadId, estado: 'active', accountId: null })
      .select('nombre emails accountId')
      .sort({ _id: 1 })
      .lean()
      .exec()) as TerceroLean[];
    const elegibles = candidatos.filter(
      (t) => correoDeInvitacion(t.emails) !== null,
    );
    const pagina = elegibles.slice(0, limite);
    const pendientes = elegibles.length - pagina.length;

    const grupos = new Map<string, TerceroLean[]>();
    for (const t of pagina) {
      const correo = correoDeInvitacion(t.emails)!;
      grupos.set(correo, [...(grupos.get(correo) ?? []), t]);
    }
    const colas = [...grupos.values()];
    const resultados = new Map<
      string,
      { omitido?: string; error?: string; creado?: AccesoProcesado }
    >();

    let siguiente = 0;
    const trabajador = async (): Promise<void> => {
      while (siguiente < colas.length) {
        const cola = colas[siguiente++];
        for (const tercero of cola) {
          const clave = tercero._id.toString();
          try {
            const creado = await this.procesar(
              tercero,
              copropiedadId,
              { vincularExistente: false, masivo: true },
              user,
            );
            resultados.set(clave, { creado });
          } catch (error: unknown) {
            if (error instanceof CuentaExistenteOmitida) {
              resultados.set(clave, { omitido: error.message });
            } else {
              if (!(error instanceof HttpException)) {
                this.logger.error(
                  `Falló el acceso del tercero ${clave}: ${(error as Error).message}`,
                );
              }
              resultados.set(clave, { error: mensajeDe(error) });
            }
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(APROVISIONAMIENTOS_SIMULTANEOS, colas.length) },
        trabajador,
      ),
    );

    const omitidos: AprovisionamientoResidentes['omitidos'] = [];
    const errores: AprovisionamientoResidentes['errores'] = [];
    let creados = 0;
    let invitacionesEnviadas = 0;
    for (const tercero of pagina) {
      const terceroId = tercero._id.toString();
      const r = resultados.get(terceroId);
      if (r?.creado) {
        creados += 1;
        if (r.creado.invitacionEnviada) invitacionesEnviadas += 1;
      } else if (r?.omitido) {
        omitidos.push({ terceroId, motivo: r.omitido });
      } else {
        errores.push({
          terceroId,
          mensaje: r?.error ?? 'No se procesó',
        });
      }
    }

    return {
      procesados: pagina.length,
      creados,
      omitidos,
      errores,
      pendientes,
      siguienteDesde:
        pendientes > 0 ? pagina[pagina.length - 1]._id.toString() : null,
      invitacionesEnviadas,
      correoConfigurado: this.invitaciones.correoConfigurado(),
    };
  }
}
