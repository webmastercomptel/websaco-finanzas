// src/modules/ingreso-portal/ingreso-portal.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Auth } from 'firebase-admin/auth';
import { Model, Types } from 'mongoose';
import { AccesoService } from '../../common/acceso/acceso.service';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import { CorreoService } from '../../common/correo/correo.service';
import { cuentaAdmiteSesionPorEnlace } from '../../common/cuentas/politica-enlace';
import { FIREBASE_AUTH } from '../../common/firebase/firebase.constants';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import {
  claveCorreo,
  esEmailValido,
  normalizarEmail,
} from '../../common/utils/email.utils';
import {
  Account,
  type AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  type AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import type { OrigenEnlaceIngreso } from '../../database/schemas/cuentas/enlace-ingreso.schema';
import type { CanjeIngresoPortal } from '../../contracts';
import { diagnosticarFrontendUrl } from '../health/frontend-url.health';
import { construirCorreoIngreso } from './correo-ingreso';
import {
  construirEnlaceIngreso,
  EnlaceIngresoService,
} from './enlace-ingreso.service';
import { clavesLimite, LIMITES_INGRESO } from './ingreso-portal.constantes';

/** Why an address cannot receive a sign-in link. Staff see these; the public never does. */
export type MotivoInelegible = 'sin-registro' | 'revocado' | 'cuenta-inactiva';

export interface Elegibilidad {
  elegible: boolean;
  motivo: MotivoInelegible | null;
  /** Coproperties the address reaches and is NOT revoked in. */
  copropiedadIds: string[];
}

/** The Account of an address as the redeem reads it. */
export type CuentaDeIngreso = Pick<
  AccountDocument,
  | '_id'
  | 'email'
  | 'firebaseUid'
  | 'estado'
  | 'esAdministradorPlataforma'
  | 'correoProbadoClave'
>;

/** What sending a link came to. `fallo` covers configuration and provider errors. */
export type ResultadoEnvioIngreso =
  'enviado' | 'sin-correo-configurado' | 'fallo';

/**
 * Sign-in by proven address: the request half (who gets a link and how it is
 * sent). The redeem half joins this class in the next units.
 *
 * `solicitar` is the BACKGROUND WORK of the public request route: it never
 * throws, it answers nothing, and every refusal is silent, because the route
 * replies on a fixed clock whatever happens here. Its logs carry reason codes
 * only: never the address, the token, its hash, the IP or an error message (a
 * driver error can echo a duplicate key's value).
 */
@Injectable()
export class IngresoPortalService {
  private readonly logger = new Logger(IngresoPortalService.name);

  constructor(
    private readonly residencia: ResidenciaService,
    private readonly enlaces: EnlaceIngresoService,
    private readonly correo: CorreoService,
    private readonly config: ConfigService,
    private readonly limite: LimiteIntentosService,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    private readonly acceso: AccesoService,
    @Inject(FIREBASE_AUTH) private readonly auth: Auth,
  ) {}

  /**
   * Counts one request for the address against both per-address windows (3 per
   * 15 minutes, 10 per 24 hours) and says whether it is still within them.
   * Shared by the self-service request and the staff resend. It is called the
   * same way for known and unknown addresses (it runs BEFORE any lookup), and
   * both windows are always counted, so the number of Redis calls never depends
   * on the address. The key is built from `claveCorreo`, never the address.
   * The limiter fails closed: Redis down answers false.
   */
  async tomarCupoCorreo(correo: string): Promise<boolean> {
    const clave = claveCorreo(correo);
    const { correoCorta, correoLarga } = LIMITES_INGRESO;
    const corta = await this.limite.permitir(
      clavesLimite.correoCorta(clave),
      correoCorta.limite,
      correoCorta.ventanaMs,
    );
    const larga = await this.limite.permitir(
      clavesLimite.correoLarga(clave),
      correoLarga.limite,
      correoLarga.ventanaMs,
    );
    return corta && larga;
  }

  /**
   * May this address be e-mailed a sign-in link right now? Yes when it reaches
   * at least one active unit (as titular or arrendatario) of an active
   * coproperty that contracted a module, is not under an active revocation in
   * EVERY one of those coproperties, and its Account (if it has one) is active.
   * Reads the records on the spot: nothing is cached.
   */
  async evaluarElegibilidad(correo: string): Promise<Elegibilidad> {
    const normalizado = normalizarEmail(correo);
    const alcanzadas =
      await this.residencia.copropiedadesPorCorreo(normalizado);
    if (alcanzadas.size === 0) {
      return { elegible: false, motivo: 'sin-registro', copropiedadIds: [] };
    }

    const ids = [...alcanzadas.keys()];
    const revocadas = await this.residencia.revocacionesActivas(
      claveCorreo(normalizado),
      ids,
    );
    const libres = ids.filter((id) => !revocadas.has(id));
    if (libres.length === 0) {
      return { elegible: false, motivo: 'revocado', copropiedadIds: [] };
    }

    const cuenta = await this.cuentas
      .findOne({ email: normalizado })
      .select('estado')
      .lean()
      .exec();
    if (cuenta && cuenta.estado !== 'active') {
      return { elegible: false, motivo: 'cuenta-inactiva', copropiedadIds: [] };
    }
    return { elegible: true, motivo: null, copropiedadIds: libres };
  }

  /**
   * Mints a link for the address and e-mails it, and nothing else: eligibility
   * and limits are the caller's. Nothing is minted when mail cannot go out (an
   * issued link is a live credential; none is made for nothing). The address
   * already is the one on a record; it is the only recipient (`to`).
   */
  async emitirYEnviar(
    correo: string,
    origen: OrigenEnlaceIngreso,
    solicitadoPor: Types.ObjectId | null,
  ): Promise<ResultadoEnvioIngreso> {
    if (!this.correo.estaConfigurado()) return 'sin-correo-configurado';

    const frontendUrl = this.config.get<string>('app.frontendUrl');
    if (diagnosticarFrontendUrl(frontendUrl) !== null) {
      this.logger.warn('Ingreso: FRONTEND_URL falta o es inválida.');
      return 'fallo';
    }

    const normalizado = normalizarEmail(correo);
    const { token } = await this.enlaces.crear({
      correo: normalizado,
      origen,
      solicitadoPor,
    });
    const { asunto, html } = construirCorreoIngreso({
      enlace: construirEnlaceIngreso(frontendUrl!, token),
    });
    const enviado = await this.correo.enviar({
      para: normalizado,
      asunto,
      html,
      sinRegistrarDestinatario: true,
    });
    return enviado ? 'enviado' : 'fallo';
  }

  /**
   * The work behind `POST /auth/portal/solicitar`. Order: shape, per-address
   * counter, eligibility, then mint and send. Any refusal returns quietly; any
   * error is caught and logged as a reason code.
   */
  async solicitar(correo: string): Promise<void> {
    try {
      const normalizado = normalizarEmail(correo);
      // Not an address: nothing to count, look up or send.
      if (!esEmailValido(normalizado)) return;

      if (!(await this.tomarCupoCorreo(normalizado))) {
        this.logger.debug('Ingreso: solicitud sin cupo (motivo=limite).');
        return;
      }

      const elegibilidad = await this.evaluarElegibilidad(normalizado);
      if (!elegibilidad.elegible) return;

      const resultado = await this.emitirYEnviar(
        normalizado,
        'autoservicio',
        null,
      );
      if (resultado !== 'enviado') {
        this.logger.warn(
          `Ingreso: no se envió el enlace (motivo=${resultado}).`,
        );
      }
    } catch (error: unknown) {
      // The error NAME only: a driver message can carry key values.
      this.logger.error(
        `Ingreso: la solicitud falló (motivo=error, tipo=${(error as Error)?.name ?? 'desconocido'}).`,
      );
    }
  }

  /**
   * First-use Account of a resident whose address has none. Implemented in the
   * next unit (identity through `FirebaseUsuariosService`, then the Account and
   * its audit entry in one transaction); the redeem depends on this signature
   * only. Until then it refuses, so nothing can half-create an Account.
   */
  async crearCuentaPrimerUso(
    _correo: string,
    _copropiedadIds: string[],
  ): Promise<CuentaDeIngreso> {
    await Promise.resolve();
    throw new Error('crearCuentaPrimerUso: aún no disponible');
  }

  /**
   * The explicit redeem behind `POST /auth/portal/canjear`: spends the link,
   * checks the address again, finds or creates its Account and answers a
   * session or a confirmation. Answers `null` for EVERY refusal and for any
   * error, and never says which: the controller turns it into one opaque 401.
   *
   * Order, and why:
   *  1. `consumir` first. Of any number of concurrent redeems exactly one gets
   *     the link, and a refusal later (address no longer eligible) leaves it
   *     spent.
   *  2. Eligibility again, from the records right now (the address may have
   *     left the record, the unit been sold, the address revoked).
   *  3. The Account of that address: none (first use), inactive (kill switch:
   *     refusal, NO proof), or active.
   *  4. The shared link policy decides session or `confirmado`. Staff with
   *     Finanzas keys, administrativo rows and platform admins never get a
   *     session from a link; they proved their address and sign in with their
   *     password.
   *  5. The custom token is minted BEFORE the proof is written, so a failed mint
   *     leaves no proof; a refusal writes none.
   * No branch creates or changes an `Asignacion`, a role, `permisos` or the
   * identity of an existing account.
   */
  async canjear(token: string): Promise<CanjeIngresoPortal | null> {
    try {
      const fila = await this.enlaces.consumir(token);
      if (!fila) return this.rechazarCanje('enlace');

      const elegibilidad = await this.evaluarElegibilidad(fila.correo);
      if (!elegibilidad.elegible) return this.rechazarCanje('inelegible');

      const existente = await this.cuentas
        .findOne({ email: fila.correo })
        .lean()
        .exec();
      const cuenta =
        existente ??
        (await this.crearCuentaPrimerUso(
          fila.correo,
          elegibilidad.copropiedadIds,
        ));
      if (cuenta.estado !== 'active') return this.rechazarCanje('cuenta');

      const conSesion = await this.admiteSesion(cuenta);
      const customToken = conSesion
        ? await this.auth.createCustomToken(cuenta.firebaseUid)
        : null;
      await this.registrarPrueba(cuenta._id, fila.clave);

      return customToken === null
        ? { resultado: 'confirmado' }
        : { resultado: 'sesion', customToken };
    } catch (error: unknown) {
      this.logger.warn(
        `Ingreso: canje fallido (motivo=error, tipo=${(error as Error)?.name ?? 'desconocido'}).`,
      );
      return null;
    }
  }

  private rechazarCanje(motivo: string): null {
    this.logger.debug(`Ingreso: canje rechazado (motivo=${motivo}).`);
    return null;
  }

  /**
   * May a link open a session for this account? The shared policy
   * (`cuentaAdmiteSesionPorEnlace`), asked in the cheapest order: inactive and
   * platform-admin accounts need no query, any Finanzas key ends it before the
   * second query, and only then the administrativo-assignment check.
   */
  private async admiteSesion(cuenta: CuentaDeIngreso): Promise<boolean> {
    if (
      !cuentaAdmiteSesionPorEnlace({
        cuenta,
        accesos: [],
        tieneNoPersonal: false,
      })
    ) {
      return false;
    }
    // Every coproperty the account reaches, not one: the session a link opens
    // is not pinned to a building.
    const accesos = await this.acceso.copropiedadesDe(
      cuenta._id.toString(),
      false,
      cuenta,
    );
    if (
      !cuentaAdmiteSesionPorEnlace({ cuenta, accesos, tieneNoPersonal: false })
    ) {
      return false;
    }
    const administrativo = await this.asignaciones
      .exists({
        accountId: cuenta._id,
        estado: 'active',
        perfil: { $ne: 'personal' },
      })
      .exec();
    return cuentaAdmiteSesionPorEnlace({
      cuenta,
      accesos,
      tieneNoPersonal: !!administrativo,
    });
  }

  /**
   * Records that the person proved the address: the clave of the Account's
   * address, when it was first proven (kept by later redeems, restarted when
   * the stored proof was for another address) and the last entry. Two plain
   * writes, the date first: its filter compares the OLD clave.
   */
  private async registrarPrueba(
    cuentaId: Types.ObjectId,
    clave: string,
  ): Promise<void> {
    const ahora = new Date();
    await this.cuentas
      .updateOne(
        {
          _id: cuentaId,
          $or: [
            { correoProbadoEn: null },
            { correoProbadoClave: { $ne: clave } },
          ],
        },
        { $set: { correoProbadoEn: ahora } },
      )
      .exec();
    await this.cuentas
      .updateOne(
        { _id: cuentaId },
        { $set: { correoProbadoClave: clave, ultimoIngresoPortalEn: ahora } },
      )
      .exec();
  }
}
