import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import type {
  EventoPqr,
  PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  ETIQUETA_ORGANO,
  type OrganoCopropiedad,
} from '../../database/schemas/administracion/integrante-organo.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { OrganosService } from '../organos/organos.service';
import {
  construirCorreoPqrAcuse,
  construirCorreoPqrCierre,
  construirCorreoPqrNueva,
  construirCorreoPqrOrgano,
  construirCorreoPqrRespuesta,
  construirCorreoPqrTecnico,
} from './pqr-correo';
import { evento } from './pqr-etapas';

/** Type labels as they read in the technician's e-mail. */
const ETIQUETA_TIPO: Record<string, string> = {
  peticiones: 'Petición',
  quejas: 'Queja',
  reclamos: 'Reclamo',
  sugerencias: 'Sugerencia',
  felicitaciones: 'Felicitación',
  denuncias: 'Denuncia',
};

/** The UTC date of a business date stored at midnight, `d/M/yyyy`. */
const fechaUtc = (fecha: Date): string =>
  `${fecha.getUTCDate()}/${fecha.getUTCMonth() + 1}/${fecha.getUTCFullYear()}`;

/** The Bogotá day (UTC-5, no DST) of an instant, `d/M/yyyy`. */
const fechaBogota = (fecha: Date): string =>
  fechaUtc(new Date(fecha.getTime() - 5 * 3_600_000));

/** One resident-side recipient of the acknowledgment or the final answer. */
export interface DestinatarioResidente {
  correos: string[];
  nombre: string;
  enlace: string | null;
  /** Set when there is an account, to also leave the in-app notice. */
  accountId?: string;
}

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
    private readonly organos: OrganosService,
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

  /**
   * Who answers for the person the PQRS is about: the author's account when a
   * resident filed it (portal link, as `notificarRespuesta` does), otherwise the
   * addresses on the unit named by `pqr.unidad` (staff filed it on their behalf;
   * one entry per address, no link, no account). Empty when nobody can be reached.
   */
  async destinatariosDelResidente(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
  ): Promise<DestinatarioResidente[]> {
    if (pqr.autorId) {
      const autorId = pqr.autorId.toString();
      const destinatario = await this.directorio.destinatarioDe(
        autorId,
        copropiedadId,
        'Pqr',
      );
      if (!destinatario) return [];
      const ruta = destinatario.perfil === 'residente' ? '/portal/pqr' : '/pqr';
      const enlace = await this.enlaces.construir(
        destinatario.accountId,
        copropiedadId.toString(),
        `${ruta}?abrir=${pqr._id.toString()}`,
      );
      return [
        {
          correos: [destinatario.email],
          nombre: destinatario.nombre,
          enlace,
          accountId: destinatario.accountId,
        },
      ];
    }

    const inmuebleId = await this.directorio.inmuebleIdPorCodigo(
      copropiedadId,
      pqr.unidad ?? '',
    );
    if (!inmuebleId) return [];
    const porUnidad = await this.directorio.correosDeInmuebles(copropiedadId, [
      inmuebleId,
    ]);
    return (porUnidad.get(inmuebleId.toString()) ?? []).map((destino) => ({
      correos: [destino.email],
      nombre: destino.nombre,
      enlace: null,
    }));
  }

  /**
   * E-mails every resident-side recipient; resolves to how many sends the
   * provider accepted. Never throws and never logs an address.
   */
  private async enviarAlResidente(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
    construir: (destinatario: DestinatarioResidente) => {
      asunto: string;
      html: string;
    },
  ): Promise<number> {
    let enviados = 0;
    try {
      const destinatarios = await this.destinatariosDelResidente(
        pqr,
        copropiedadId,
      );
      for (const destinatario of destinatarios) {
        try {
          const { asunto, html } = construir(destinatario);
          for (const para of destinatario.correos) {
            const ok = await this.correo.enviar({ para, asunto, html });
            if (ok) enviados += 1;
            else {
              this.logger.error(`No se pudo notificar la PQR ${pqr.codigo}.`);
            }
          }
          if (destinatario.accountId) {
            await this.notificaciones.crear({
              copropiedadId,
              accountId: destinatario.accountId,
              tipo: 'pqr',
              titulo: asunto,
            });
          }
        } catch (error: unknown) {
          this.logger.error(
            `No se pudo notificar la PQR ${pqr.codigo}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo resolver el destinatario de la PQR ${pqr.codigo}: ${(error as Error).message}`,
      );
    }
    return enviados;
  }

  /**
   * Acknowledgment of receipt to whoever the PQRS is about. Returns the log
   * entry the caller pushes; never throws.
   */
  async notificarAcuse(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
  ): Promise<EventoPqr> {
    const sistema = { nombre: 'Sistema' };
    try {
      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      const creada = (pqr as { createdAt?: Date }).createdAt ?? new Date();
      const enviados = await this.enviarAlResidente(
        pqr,
        copropiedadId,
        (destinatario) =>
          construirCorreoPqrAcuse({
            nombreDestinatario: destinatario.nombre,
            nombreCopropiedad,
            codigo: pqr.codigo,
            titulo: pqr.titulo,
            fechaRadicacion: fechaBogota(creada),
            enlace: destinatario.enlace,
          }),
      );
      if (enviados > 0) {
        return evento(
          'acuse_enviado',
          `Acuse de radicado enviado a ${enviados} destinatario(s)`,
          sistema,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo enviar el acuse de la PQR ${pqr.codigo}: ${(error as Error).message}`,
      );
    }
    return evento(
      'acuse_sin_destinatario',
      'No se envió acuse: el inmueble no coincide o no tiene correo registrado',
      sistema,
    );
  }

  /**
   * Tells the members of the Consejo / Comité that a PQRS was assigned to
   * them. Returns the log entry to push; never throws and never names addresses.
   */
  async avisarOrgano(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
    organo: OrganoCopropiedad,
  ): Promise<EventoPqr> {
    const etiqueta = ETIQUETA_ORGANO[organo];
    const sistema = { nombre: 'Sistema' };
    let enviados = 0;
    try {
      const correos = await this.organos.correosDeOrgano(copropiedadId, organo);
      if (correos.length > 0) {
        const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
        const { asunto, html } = construirCorreoPqrOrgano({
          nombreCopropiedad,
          organo: etiqueta,
          codigo: pqr.codigo,
          tipo: pqr.tipo,
          titulo: pqr.titulo,
          descripcion: pqr.descripcion || pqr.descripcionCompleta,
          unidad: pqr.unidad,
          fechaLimite: pqr.fechaLimite ? fechaUtc(pqr.fechaLimite) : '',
        });
        for (const para of correos) {
          try {
            if (await this.correo.enviar({ para, asunto, html })) enviados += 1;
          } catch {
            // CorreoService never throws; this keeps a stub from stopping the rest.
          }
        }
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo avisar al ${etiqueta} de la PQR ${pqr.codigo}: ${(error as Error).message}`,
      );
    }
    return enviados > 0
      ? evento(
          'aviso_organo',
          `Aviso enviado a ${enviados} integrantes del ${etiqueta}`,
          sistema,
        )
      : evento(
          'aviso_organo',
          `No hay integrantes con correo en el ${etiqueta}`,
          sistema,
        );
  }

  /**
   * Tells a technician a PQRS was assigned to them. Returns the log entry to
   * push; never throws and never names the address (the entry and the logs
   * carry the technician's name only).
   */
  async notificarTecnico(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
    tecnico: { nombre: string; email: string },
  ): Promise<EventoPqr> {
    const sistema = { nombre: 'Sistema' };
    const para = tecnico.email?.trim() ?? '';
    if (!para) {
      return evento(
        'aviso_tecnico',
        `El técnico ${tecnico.nombre} no tiene correo registrado`,
        sistema,
      );
    }
    let enviado = false;
    try {
      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      const { asunto, html } = construirCorreoPqrTecnico({
        nombreTecnico: tecnico.nombre,
        nombreCopropiedad,
        codigo: pqr.codigo,
        tipo: ETIQUETA_TIPO[pqr.tipo] ?? pqr.tipo,
        titulo: pqr.titulo,
        descripcion: pqr.descripcion || pqr.descripcionCompleta,
        unidad: pqr.unidad,
        fechaLimite: pqr.fechaLimite ? fechaUtc(pqr.fechaLimite) : '',
      });
      enviado = await this.correo.enviar({
        para,
        asunto,
        html,
        sinRegistrarDestinatario: true,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo avisar al técnico de la PQR ${pqr.codigo}: ${(error as Error).name}`,
      );
    }
    return evento(
      'aviso_tecnico',
      enviado
        ? `Correo enviado al técnico ${tecnico.nombre}`
        : `No se pudo enviar el correo al técnico ${tecnico.nombre}`,
      sistema,
    );
  }

  /** Final answer to whoever the PQRS is about; the PQRS is closed. Never throws. */
  async notificarCierre(
    pqr: PqrDocument,
    copropiedadId: Types.ObjectId,
    mensaje: string,
  ): Promise<void> {
    try {
      const nombreCopropiedad = await this.nombreDeCopropiedad(copropiedadId);
      await this.enviarAlResidente(pqr, copropiedadId, (destinatario) =>
        construirCorreoPqrCierre({
          nombreDestinatario: destinatario.nombre,
          nombreCopropiedad,
          codigo: pqr.codigo,
          titulo: pqr.titulo,
          mensaje,
          enlace: destinatario.enlace,
        }),
      );
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar el cierre de la PQR ${pqr.codigo}: ${(error as Error).message}`,
      );
    }
  }
}
