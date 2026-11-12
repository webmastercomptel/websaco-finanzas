// src/modules/ingreso-portal/ingreso-portal.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import { CorreoService } from '../../common/correo/correo.service';
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
import type { OrigenEnlaceIngreso } from '../../database/schemas/cuentas/enlace-ingreso.schema';
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
}
