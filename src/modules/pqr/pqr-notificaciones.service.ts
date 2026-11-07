import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import type { PqrDocument } from '../../database/schemas/administracion/pqr.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import {
  construirCorreoPqrNueva,
  construirCorreoPqrRespuesta,
} from './pqr-correo';

/**
 * How many people are emailed at once. The host only has CPU while a request is
 * open, so the notices are awaited inside it; this bounds the burst against the
 * mail provider and Mongo instead of firing every send together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/** Who just wrote on a PQR. */
export interface EscritorPqr {
  accountId?: string;
  nombre: string;
}

/**
 * Notices produced by the PQR module: staff learn of a new PQR, its author
 * learns of a reply.
 *
 * Every method is best-effort and NEVER throws: the PQR or the reply already
 * exists, and a mail outage must not undo it or turn the request into a 500.
 * The audience comes from `DirectorioService`, not from roles: staff are the
 * accounts whose effective permissions can read `Pqr`, and the author is
 * addressed as the profile they are (a resident reaches the portal screen, a
 * staff member the back-office one), so a link never points at a screen the
 * recipient cannot open.
 */
@Injectable()
export class PqrNotificacionesService {
  private readonly logger = new Logger(PqrNotificacionesService.name);

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
    pqr: PqrDocument,
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
          `No se pudo notificar la PQR ${pqr.codigo} a ${destinatario.email}.`,
        );
      }
      await this.notificaciones.crear({
        copropiedadId,
        accountId: destinatario.accountId,
        tipo: 'pqr',
        titulo: asunto,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la PQR ${pqr.codigo} a ${destinatario.email}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Tells every staff member who can read PQRs that a new one came in, in
   * batches of at most `ENVIOS_SIMULTANEOS`. Whoever filed it is skipped: they
   * know. A staff member whose permissions cannot read `Pqr` is not in the
   * audience at all.
   */
  async notificarNueva(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
    creadorId?: string,
  ): Promise<void> {
    try {
      const personal = (
        await this.directorio.personalQuePuedeLeer(copropiedadId, 'Pqr')
      ).filter((destinatario) => destinatario.accountId !== creadorId);
      if (personal.length === 0) return;

      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      const destino = `/pqr?abrir=${pqr._id.toString()}`;

      for (let i = 0; i < personal.length; i += ENVIOS_SIMULTANEOS) {
        await Promise.all(
          personal.slice(i, i + ENVIOS_SIMULTANEOS).map((destinatario) =>
            this.avisar(destinatario, pqr, copropiedadId, destino, (enlace) =>
              construirCorreoPqrNueva({
                nombreDestinatario: destinatario.nombre,
                nombreCopropiedad,
                codigo: pqr.codigo,
                titulo: pqr.titulo,
                tipo: pqr.tipo,
                prioridad: pqr.prioridad,
                unidad: pqr.unidad,
                residenteNombre: pqr.residente?.nombre ?? '',
                descripcion: pqr.descripcion || pqr.descripcionCompleta,
                enlace,
              }),
            ),
          ),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la nueva PQR ${pqr.codigo}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Tells the PQR's author about a new reply. Nothing happens when the PQR has
   * no author account (staff filed it on somebody's behalf), when the author is
   * the one who just wrote, or when the author can no longer be reached (an
   * inactive account, no access to the coproperty). A resident gets the portal
   * link, a staff author the back-office one.
   */
  async notificarRespuesta(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
    escritor: EscritorPqr,
    mensaje: string,
  ): Promise<void> {
    try {
      if (!pqr.autorId) return;
      const autorId = pqr.autorId.toString();
      if (escritor.accountId === autorId) return;

      const destinatario = await this.directorio.destinatarioDe(
        autorId,
        copropiedadId,
        'Pqr',
      );
      if (!destinatario) return;

      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      const ruta = destinatario.perfil === 'residente' ? '/portal/pqr' : '/pqr';
      await this.avisar(
        destinatario,
        pqr,
        copropiedadId,
        `${ruta}?abrir=${pqr._id.toString()}`,
        (enlace) =>
          construirCorreoPqrRespuesta({
            nombreDestinatario: destinatario.nombre,
            nombreCopropiedad,
            codigo: pqr.codigo,
            titulo: pqr.titulo,
            autor: escritor.nombre,
            mensaje,
            enlace,
          }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la respuesta de la PQR ${pqr.codigo}: ${(error as Error).message}`,
      );
    }
  }
}
