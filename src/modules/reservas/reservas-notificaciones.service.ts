// src/modules/reservas/reservas-notificaciones.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import type { ReservaDocument } from '../../database/schemas/administracion/reserva.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import {
  construirCorreoReservaNueva,
  construirCorreoReservaRespuesta,
  type RespuestaReserva,
} from './reserva-correo';

/**
 * How many people are emailed at once. The host only has CPU while a request is
 * open, so the notices are awaited inside it; this bounds the burst against the
 * mail provider and Mongo instead of firing every send together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/**
 * Notices produced by the reservations module: staff learn of a new request,
 * whoever requested it learns how staff answered.
 *
 * Every method is best-effort and NEVER throws: the booking or the new state
 * already exists, and a mail outage must not undo it or turn the request into a
 * 500. The audience comes from `DirectorioService`, not from roles: staff are
 * the accounts whose effective permissions can read `Reserva`, and the requester
 * is addressed as the profile they are (a resident reaches the portal screen, a
 * staff member the back-office one), so a link never points at a screen the
 * recipient cannot open. Nobody is told about what they did themselves.
 */
@Injectable()
export class ReservasNotificacionesService {
  private readonly logger = new Logger(ReservasNotificacionesService.name);

  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /** `findById` is allowed here: the id IS the tenant. */
  private async nombreDeCopropiedad(
    copropiedadId: Types.ObjectId,
  ): Promise<string> {
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('nombre')
      .exec();
    return copropiedad?.nombre ?? '';
  }

  /**
   * One recipient's email (with a sign-in button when an access link may be
   * issued) plus their in-app entry. Never throws, so one bad recipient cannot
   * stop the others; a null link still sends the email, just without the button.
   */
  private async avisar(
    destinatario: Destinatario,
    reserva: ReservaDocument,
    copropiedadId: Types.ObjectId,
    destino: string,
    construir: (enlace: string | null) => { asunto: string; html: string },
  ): Promise<void> {
    try {
      const enlace = await this.enlaces.construir(
        destinatario.accountId,
        copropiedadId.toString(),
        destino,
      );
      const { asunto, html } = construir(enlace);

      const enviado = await this.correo.enviar({
        para: destinatario.email,
        asunto,
        html,
      });
      if (!enviado) {
        this.logger.error(
          `No se pudo notificar la reserva ${reserva._id.toString()} a ${destinatario.email}.`,
        );
      }
      await this.notificaciones.crear({
        copropiedadId,
        accountId: destinatario.accountId,
        tipo: 'reserva',
        titulo: asunto,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la reserva ${reserva._id.toString()} a ${destinatario.email}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Tells every staff member who can read reservations that one needs an
   * answer, in batches of at most `ENVIOS_SIMULTANEOS`. `creadorId` (whoever
   * just registered it, when that is a staff member) is skipped: they know. A
   * staff member whose permissions cannot read `Reserva` is not in the audience.
   */
  async notificarNueva(
    reserva: ReservaDocument,
    espacio: string,
    copropiedadId: Types.ObjectId,
    creadorId?: string,
  ): Promise<void> {
    try {
      const personal = (
        await this.directorio.personalQuePuedeLeer(copropiedadId, 'Reserva')
      ).filter((destinatario) => destinatario.accountId !== creadorId);
      if (personal.length === 0) return;

      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      const destino = `/reservas?abrir=${reserva._id.toString()}`;

      for (let i = 0; i < personal.length; i += ENVIOS_SIMULTANEOS) {
        await Promise.all(
          personal.slice(i, i + ENVIOS_SIMULTANEOS).map((destinatario) =>
            this.avisar(
              destinatario,
              reserva,
              copropiedadId,
              destino,
              (enlace) =>
                construirCorreoReservaNueva({
                  nombreDestinatario: destinatario.nombre,
                  nombreCopropiedad,
                  espacio,
                  inicio: reserva.inicio,
                  fin: reserva.fin,
                  residenteNombre: reserva.residente,
                  unidad: reserva.unidad,
                  motivo: reserva.motivo,
                  enlace,
                }),
            ),
          ),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la nueva reserva ${reserva._id.toString()}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Tells whoever requested the reservation that staff approved, rejected or
   * cancelled it. Nothing happens when it has no author account (staff
   * registered it on somebody's behalf), when the author is the one who just
   * acted, or when the author can no longer be reached (an inactive account, no
   * access to the coproperty). A resident gets the portal link, a staff author
   * the back-office one.
   */
  async notificarRespuesta(
    reserva: ReservaDocument,
    espacio: string,
    copropiedadId: Types.ObjectId,
    respuesta: RespuestaReserva,
    actorId?: string,
  ): Promise<void> {
    try {
      if (!reserva.autorId) return;
      const autorId = reserva.autorId.toString();
      if (actorId === autorId) return;

      const destinatario = await this.directorio.destinatarioDe(
        autorId,
        copropiedadId,
        'Reserva',
      );
      if (!destinatario) return;

      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      const ruta =
        destinatario.perfil === 'residente' ? '/portal/reservas' : '/reservas';
      await this.avisar(
        destinatario,
        reserva,
        copropiedadId,
        `${ruta}?abrir=${reserva._id.toString()}`,
        (enlace) =>
          construirCorreoReservaRespuesta({
            nombreDestinatario: destinatario.nombre,
            nombreCopropiedad,
            espacio,
            inicio: reserva.inicio,
            fin: reserva.fin,
            respuesta,
            enlace,
          }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la respuesta de la reserva ${reserva._id.toString()}: ${(error as Error).message}`,
      );
    }
  }
}
