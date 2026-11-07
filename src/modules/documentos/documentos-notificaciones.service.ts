// src/modules/documentos/documentos-notificaciones.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import type { ArchivoDocumentoDocument } from '../../database/schemas/administracion/documento-archivo.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { PortalAccesoService } from '../portal/portal-acceso.service';
import {
  aclsEfectivos,
  reglasDejanLeerAResidente,
  type TipoResidente,
} from './documentos-acceso';
import { DocumentosActorService } from './documentos-actor.service';
import { construirCorreoDocumentoNuevo } from './documento-correo';
import type { MapaCarpetas } from './carpetas.service';

/**
 * How many people are emailed at once. The host only has CPU while a request is
 * open, so the notices are awaited inside it; this bounds the burst against the
 * mail provider and Mongo instead of firing every send together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/**
 * Tells everybody who can READ a folder that a document was uploaded to it.
 *
 * The audience follows the folder's effective rules, not a blanket list: staff
 * are the accounts whose permissions can read `Documento` AND who either hold
 * `gestionar` or have a role named by a readable rule; residents are those whose
 * unit holdings match a readable `residentes` rule. Whoever uploaded is skipped.
 *
 * Best-effort and NEVER throws: the file is already confirmed, and a mail outage
 * must not undo it or turn the request into a 500.
 */
@Injectable()
export class DocumentosNotificacionesService {
  private readonly logger = new Logger(DocumentosNotificacionesService.name);

  constructor(
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly directorio: DirectorioService,
    private readonly actores: DocumentosActorService,
    private readonly portalAcceso: PortalAccesoService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /** One recipient: email (with a sign-in button when a link may be issued) plus inbox entry. */
  private async avisar(
    destinatario: Destinatario,
    archivo: ArchivoDocumentoDocument,
    copropiedadId: Types.ObjectId,
    datos: { nombreCopropiedad: string; carpetaRuta: string; slug: string },
  ): Promise<void> {
    try {
      const ruta =
        destinatario.perfil === 'residente'
          ? '/portal/documentos'
          : '/documentos';
      const enlace = await this.enlaces.construir(
        destinatario.accountId,
        copropiedadId.toString(),
        // The slug lands the list on the right folder; without it a document
        // inside a subfolder would never resolve.
        `${ruta}?carpeta=${datos.slug}&abrir=${archivo._id.toString()}`,
      );
      const { asunto, html } = construirCorreoDocumentoNuevo({
        nombreDestinatario: destinatario.nombre,
        nombreCopropiedad: datos.nombreCopropiedad,
        nombreDocumento: archivo.nombre,
        carpetaRuta: datos.carpetaRuta,
        autor: archivo.autorNombre || undefined,
        enlace,
      });
      const enviado = await this.correo.enviar({
        para: destinatario.email,
        asunto,
        html,
      });
      if (!enviado) {
        this.logger.error(
          `No se pudo notificar el documento ${archivo._id.toString()} a ${destinatario.email}.`,
        );
      }
      await this.notificaciones.crear({
        copropiedadId,
        accountId: destinatario.accountId,
        tipo: 'documento',
        titulo: asunto,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar el documento ${archivo._id.toString()} a ${destinatario.email}: ${(error as Error).message}`,
      );
    }
  }

  /** Residents matching the folder's rules, by how they hold their units. */
  private async avisarResidente(
    residente: Destinatario,
    acls: Parameters<typeof reglasDejanLeerAResidente>[0],
    copropiedadId: Types.ObjectId,
    archivo: ArchivoDocumentoDocument,
    datos: { nombreCopropiedad: string; carpetaRuta: string; slug: string },
  ): Promise<void> {
    try {
      const unidades = await this.portalAcceso.unidadesDe(
        residente.accountId,
        copropiedadId.toString(),
      );
      const tipos = new Set<TipoResidente>(unidades.map((u) => u.rol));
      if (!reglasDejanLeerAResidente(acls, tipos)) return;
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo resolver al residente ${residente.email} para el documento ${archivo._id.toString()}: ${(error as Error).message}`,
      );
      return;
    }
    await this.avisar(residente, archivo, copropiedadId, datos);
  }

  async notificarNuevo(
    archivo: ArchivoDocumentoDocument,
    mapa: MapaCarpetas,
    rutaTexto: string,
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    try {
      const carpeta = mapa.get(archivo.carpetaId.toString());
      if (!carpeta) return;
      const subidoPor = archivo.subidoPorId?.toString();
      const legibles = aclsEfectivos(carpeta, mapa).filter((a) => a.puedeLeer);

      // `findById` is allowed here: the id IS the tenant.
      const copropiedad = await this.copropiedades
        .findById(copropiedadId)
        .select('nombre')
        .exec();
      const datos = {
        nombreCopropiedad: copropiedad?.nombre ?? '',
        carpetaRuta: rutaTexto,
        slug: carpeta.slug,
      };

      // Staff: can read the subject AND can reach this folder.
      const personal = (
        await this.directorio.personalQuePuedeLeer(copropiedadId, 'Documento')
      ).filter((d) => d.accountId !== subidoPor);
      const actores = await this.actores.deCuentas(
        personal.map((d) => d.accountId),
        copropiedadId,
      );
      const rolesLegibles = new Set(
        legibles.flatMap((a) =>
          a.tipo === 'rol' && a.rolId != null ? [a.rolId.toString()] : [],
        ),
      );
      const staff = personal.filter((d) => {
        const actor = actores.get(d.accountId);
        if (!actor) return false;
        return (
          actor.gestiona || [...actor.roleIds].some((r) => rolesLegibles.has(r))
        );
      });

      // Residents: only when some readable rule names them. A person who is
      // both staff and resident gets one notice, as staff.
      const yaAvisados = new Set(staff.map((d) => d.accountId));
      const hayReglaDeResidentes = legibles.some(
        (a) => a.tipo === 'residentes',
      );
      const residentes = hayReglaDeResidentes
        ? (await this.directorio.residentes(copropiedadId)).filter(
            (d) => d.accountId !== subidoPor && !yaAvisados.has(d.accountId),
          )
        : [];

      const tareas: Array<() => Promise<void>> = [
        ...staff.map(
          (d) => () => this.avisar(d, archivo, copropiedadId, datos),
        ),
        ...residentes.map(
          (d) => () =>
            this.avisarResidente(d, legibles, copropiedadId, archivo, datos),
        ),
      ];
      for (let i = 0; i < tareas.length; i += ENVIOS_SIMULTANEOS) {
        await Promise.all(
          tareas.slice(i, i + ENVIOS_SIMULTANEOS).map((tarea) => tarea()),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar el nuevo documento ${archivo._id.toString()}: ${(error as Error).message}`,
      );
    }
  }
}
