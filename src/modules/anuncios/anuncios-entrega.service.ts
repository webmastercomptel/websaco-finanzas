// src/modules/anuncios/anuncios-entrega.service.ts
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { Anuncio as AnuncioContrato } from '../../contracts';
import {
  Anuncio,
  type AnuncioDocument,
} from '../../database/schemas/administracion/anuncio.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import {
  construirAsuntoAnuncio,
  construirCorreoAnuncio,
  personalizarContenido,
} from './anuncio-correo';
import { toAnuncio } from './anuncios.mapper';

/**
 * How many residents are delivered to at once. The host only has CPU while a
 * request is open, so delivery is awaited inside it; this bounds the burst
 * against the mail provider and Mongo instead of firing hundreds of sends
 * together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/**
 * How long a delivery lease lives without a heartbeat. The holder renews it
 * after every batch, so a live request never loses it; a request that died
 * (instance killed mid-send) leaves it to expire, after which publishing again
 * resumes. Long enough to outlast one batch of slow sends, short enough that a
 * stuck announcement is not unusable for long.
 */
export const VIGENCIA_ENVIO_MS = 3 * 60 * 1000;

/** The two delivery-progress arrays of an announcement. */
type CampoProgreso = 'notificadosIds' | 'correosEnviadosIds';

/** Everything one delivery run shares between its recipients. */
interface ContextoEntrega {
  anuncio: AnuncioDocument;
  copropiedadId: Types.ObjectId;
  nombreCopropiedad: string;
  correoConfigurado: boolean;
  /** Account ids already notified in-app (this run adds to it as it goes). */
  notificados: Set<string>;
  /** Account ids whose email was already accepted (this run adds to it too). */
  enviados: Set<string>;
}

/**
 * Publishes an announcement and delivers it to the residents of the ACTIVE
 * coproperty, INSIDE the publish request.
 *
 * Nothing runs after the response: the host only has CPU while a request is
 * open, so there is no queue and no worker. What a queue would have given
 * (retries, no double sends) is built into the document instead:
 *
 * - Progress is recorded per recipient with `$addToSet` AFTER the delivery
 *   succeeded (`notificadosIds`, `correosEnviadosIds`). Publishing again only
 *   delivers to whoever is missing, so a retry never double-sends and a request
 *   that died halfway is completed by calling publish once more.
 * - A lease (`tokenEnvio` + `envioIniciadoEn`, renewed after every batch) keeps
 *   two concurrent publish requests from delivering the same announcement at
 *   once. The claim is one atomic update, so exactly one request wins.
 * - Each recipient is isolated: one bad address or a failed write is logged and
 *   leaves that person pending; the others still get theirs.
 *
 * Trade-off, stated plainly: the progress is written after the send, so a crash
 * in the instant between the provider accepting an email and the write can send
 * that one email twice on resume. The alternative (write first) would silently
 * lose it instead; a duplicate notice is the lesser evil.
 */
@Injectable()
export class AnunciosEntregaService {
  private readonly logger = new Logger(AnunciosEntregaService.name);

  constructor(
    @InjectModel(Anuncio.name)
    private readonly anuncios: Model<AnuncioDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /**
   * Publishes (first time) or resumes (after a failure or a dead request) the
   * delivery of an announcement, and answers with how far it got. 404 when it
   * does not exist here, 409 when it was already fully sent or another request
   * is delivering it right now.
   */
  async publicar(id: string): Promise<AnuncioContrato> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Anuncio ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const token = randomUUID();
    const anuncio = await this.reclamar(id, copropiedadId, token);

    try {
      await this.entregar(anuncio, copropiedadId, token);
    } catch (error: unknown) {
      // Release the lease so the next call can resume at once instead of
      // waiting for it to expire.
      await this.soltar(anuncio._id, copropiedadId, token);
      throw error;
    }

    const actual = await this.anuncios
      .findOne({ _id: anuncio._id, copropiedadId })
      .exec();
    if (!actual) throw new NotFoundException(`Anuncio ${id} no encontrado`);
    return toAnuncio(actual, { incluirEntrega: true });
  }

  /**
   * Takes the delivery lease with ONE atomic update, so two concurrent requests
   * cannot both win. Claimable: a draft, a `fallido` one (retry), or an
   * `enviando` one whose holder stopped renewing. `publicadoEn` is stamped only
   * the first time (`$ifNull`), which needs an aggregation-pipeline update.
   */
  private async reclamar(
    id: string,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<AnuncioDocument> {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() - VIGENCIA_ENVIO_MS);
    const reclamado = await this.anuncios
      .findOneAndUpdate(
        {
          _id: id,
          copropiedadId,
          $or: [
            { estado: { $in: ['borrador', 'fallido'] } },
            {
              estado: 'enviando',
              $or: [
                { envioIniciadoEn: null },
                { envioIniciadoEn: { $lt: limite } },
              ],
            },
          ],
        },
        [
          {
            $set: {
              estado: 'enviando',
              tokenEnvio: token,
              envioIniciadoEn: ahora,
              publicadoEn: { $ifNull: ['$publicadoEn', ahora] },
            },
          },
        ],
        // Mongoose 9 only accepts an array update as a pipeline when asked to.
        { new: true, updatePipeline: true },
      )
      .exec();
    if (reclamado) return reclamado;

    // The claim matched nothing: tell "not here" from "not claimable". This read
    // only picks the error, it never decides the transition.
    const existente = await this.anuncios
      .findOne({ _id: id, copropiedadId })
      .select('estado')
      .exec();
    if (!existente) throw new NotFoundException(`Anuncio ${id} no encontrado`);
    throw new ConflictException(
      existente.estado === 'enviado'
        ? 'Este anuncio ya fue enviado.'
        : 'Este anuncio está en proceso de envío. Si se interrumpió, volvé a intentarlo en unos minutos.',
    );
  }

  /** Delivers to every resident still missing something, then settles the state. */
  private async entregar(
    anuncio: AnuncioDocument,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<void> {
    const residentes = this.sinRepetidos(
      await this.directorio.residentes(copropiedadId),
    );
    // `findById` is allowed here: the id IS the tenant.
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('nombre')
      .exec();

    const contexto: ContextoEntrega = {
      anuncio,
      copropiedadId,
      nombreCopropiedad: copropiedad?.nombre ?? '',
      correoConfigurado: this.correo.estaConfigurado(),
      notificados: new Set(anuncio.notificadosIds.map(String)),
      enviados: new Set(anuncio.correosEnviadosIds.map(String)),
    };
    if (!contexto.correoConfigurado) {
      this.logger.warn(
        `Anuncio ${anuncio._id.toString()}: el correo no está configurado; solo se crean las notificaciones dentro de la app.`,
      );
    }

    const faltantes = residentes.filter((r) => this.leFalta(r, contexto));
    for (let i = 0; i < faltantes.length; i += ENVIOS_SIMULTANEOS) {
      await Promise.all(
        faltantes
          .slice(i, i + ENVIOS_SIMULTANEOS)
          .map((residente) => this.entregarA(residente, contexto)),
      );
      // Renew the lease. No match means the announcement was deleted or another
      // request took over after ours stalled: stop, it is not ours any more.
      if (!(await this.latido(anuncio._id, copropiedadId, token))) return;
    }

    const completo = residentes.every((r) => !this.leFalta(r, contexto, true));
    await this.anuncios
      .updateOne(
        { _id: anuncio._id, copropiedadId, tokenEnvio: token },
        {
          $set: {
            estado: completo ? 'enviado' : 'fallido',
            destinatariosTotal: residentes.length,
            correoConfigurado: contexto.correoConfigurado,
            tokenEnvio: null,
            envioIniciadoEn: null,
          },
        },
      )
      .exec();
  }

  /** Same person twice (two units, two sources) must get one notice. */
  private sinRepetidos(destinatarios: Destinatario[]): Destinatario[] {
    return [...new Map(destinatarios.map((d) => [d.accountId, d])).values()];
  }

  /**
   * Whether somebody still lacks something. With `final` the email counts as
   * missing even when the environment cannot send it: the announcement is only
   * `enviado` when everything really went out, never by faking it.
   */
  private leFalta(
    residente: Destinatario,
    contexto: ContextoEntrega,
    final = false,
  ): boolean {
    if (!contexto.notificados.has(residente.accountId)) return true;
    if (contexto.enviados.has(residente.accountId)) return false;
    return final || contexto.correoConfigurado;
  }

  /**
   * One resident: the in-app entry (if missing), then the email (if missing and
   * the environment can send it). Never throws, so one bad recipient cannot stop
   * the others; whatever failed simply stays unrecorded and pending.
   */
  private async entregarA(
    residente: Destinatario,
    contexto: ContextoEntrega,
  ): Promise<void> {
    const { anuncio, copropiedadId } = contexto;
    const etiqueta = `${anuncio._id.toString()} a ${residente.email}`;
    try {
      if (!contexto.notificados.has(residente.accountId)) {
        await this.notificaciones.crear({
          copropiedadId,
          accountId: residente.accountId,
          tipo: 'anuncio',
          titulo: construirAsuntoAnuncio(
            contexto.nombreCopropiedad,
            anuncio.titulo,
          ),
        });
        await this.registrar(contexto, 'notificadosIds', residente.accountId);
        contexto.notificados.add(residente.accountId);
      }

      if (
        contexto.correoConfigurado &&
        !contexto.enviados.has(residente.accountId)
      ) {
        const enlace = await this.enlaces.construir(
          residente.accountId,
          copropiedadId.toString(),
          `/portal/anuncios?abrir=${anuncio._id.toString()}`,
        );
        const { asunto, html } = construirCorreoAnuncio({
          nombreCopropiedad: contexto.nombreCopropiedad,
          titulo: anuncio.titulo,
          contenido: personalizarContenido(anuncio.contenido, residente.nombre),
          autor: anuncio.autor,
          fecha: anuncio.publicadoEn ?? new Date(),
          enlace,
        });
        const enviado = await this.correo.enviar({
          para: residente.email,
          asunto,
          html,
        });
        if (!enviado) {
          this.logger.error(`No se pudo enviar el anuncio ${etiqueta}.`);
          return;
        }
        await this.registrar(
          contexto,
          'correosEnviadosIds',
          residente.accountId,
        );
        contexto.enviados.add(residente.accountId);
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo entregar el anuncio ${etiqueta}: ${(error as Error).message}`,
      );
    }
  }

  /** Records one recipient as delivered. Idempotent: `$addToSet` never duplicates. */
  private async registrar(
    contexto: ContextoEntrega,
    campo: CampoProgreso,
    accountId: string,
  ): Promise<void> {
    await this.anuncios
      .updateOne(
        { _id: contexto.anuncio._id, copropiedadId: contexto.copropiedadId },
        { $addToSet: { [campo]: new Types.ObjectId(accountId) } },
      )
      .exec();
  }

  /** Renews the lease; false when this request no longer owns the announcement. */
  private async latido(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<boolean> {
    const resultado = await this.anuncios
      .updateOne(
        { _id: id, copropiedadId, tokenEnvio: token },
        { $set: { envioIniciadoEn: new Date() } },
      )
      .exec();
    return resultado.matchedCount === 1;
  }

  /** Best-effort lease release after an unexpected error; never masks that error. */
  private async soltar(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<void> {
    try {
      await this.anuncios
        .updateOne(
          { _id: id, copropiedadId, tokenEnvio: token },
          {
            $set: {
              estado: 'fallido',
              tokenEnvio: null,
              envioIniciadoEn: null,
            },
          },
        )
        .exec();
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo liberar el envío del anuncio ${id.toString()}: ${(error as Error).message}`,
      );
    }
  }
}
