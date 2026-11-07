// src/modules/facturacion-bloque/facturacion-bloque-entrega.service.ts
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
  type ResidenteDeInmueble,
} from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  BloqueFacturacion as BloqueContrato,
  EntregaBloque,
} from '../../contracts';
import {
  BloqueFacturacion,
  type BloqueFacturacionDocument,
} from '../../database/schemas/administracion/bloque-facturacion.schema';
import {
  DocumentoBloque,
  type DocumentoBloqueDocument,
} from '../../database/schemas/administracion/documento-bloque.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { construirAsuntoBloque, construirCorreoBloque } from './bloque-correo';
import { puedeVerTipo, TIPOS_DE_RESIDENTE } from './facturacion-bloque-acceso';
import { toBloque } from './facturacion-bloque.mapper';

/**
 * How many (unit, resident) deliveries run at once. The host only has CPU while
 * a request is open, so delivery is awaited inside it; this bounds the burst
 * against the mail provider and Mongo instead of firing hundreds of sends
 * together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/**
 * How long a delivery lease lives without a heartbeat. The holder renews it
 * after every batch, so a live request never loses it; a request that died
 * (instance killed mid-send) leaves it to expire, after which sending again
 * resumes. Long enough to outlast one batch of slow sends, short enough that a
 * stuck block is not unusable for long.
 */
export const VIGENCIA_ENVIO_MS = 3 * 60 * 1000;

/**
 * How long the access link of a billing notice works: 35 days, as in the system
 * this was ported from. A notice must stay usable for the whole cycle (invoice
 * issued on the 8th, paid on the 29th) plus a margin, and the generic 7-day link
 * would leave the resident of a slow-moving household with a dead button. The
 * link is still refused for anybody holding a Finanzas permission.
 */
export const VIGENCIA_ENLACE_MS = 35 * 24 * 60 * 60 * 1000;

/** The two delivery-progress arrays of a unit's document. */
type CampoProgreso = 'notificadosIds' | 'correosEnviadosIds';

/** One delivery: a unit's document and one resident entitled to it. */
interface Entrega {
  documento: DocumentoBloqueDocument;
  residente: ResidenteDeInmueble;
}

/** Everything one delivery run shares between its deliveries. */
interface ContextoEntrega {
  bloque: BloqueFacturacionDocument;
  copropiedadId: Types.ObjectId;
  nombreCopropiedad: string;
  correoConfigurado: boolean;
  /** Per document id: accounts already notified in-app (this run adds to it). */
  notificados: Map<string, Set<string>>;
  /** Per document id: accounts whose email was already accepted. */
  enviados: Map<string, Set<string>>;
}

/**
 * Sends a generated block to the residents of its units, INSIDE the request that
 * pressed "send". NOTHING ELSE EVER SENDS: ingest produces documents and stops;
 * this service is only reachable from the explicit `POST :id/enviar` route.
 *
 * It follows the announcements' delivery design (no queue, no worker; the host
 * only has CPU while a request is open):
 *
 * - Progress is recorded per (document, recipient) with `$addToSet` AFTER each
 *   delivery succeeded. Sending again only reaches whoever is missing, so a
 *   retry never double-sends and a request that died halfway is completed by
 *   calling send once more.
 * - A lease (`tokenEnvio` + `envioIniciadoEn`, renewed after every batch) keeps
 *   two concurrent requests from delivering the same block. The claim is one
 *   atomic update, so exactly one wins.
 * - Each delivery is isolated: a bad address or a failed write is logged and
 *   leaves that person pending; the others still get theirs.
 *
 * WHO receives WHAT is the same rule the portal enforces when listing and
 * downloading (`puedeVerTipo`): the owner of a unit gets invoices and statements
 * of account, its tenant only invoices, and nobody gets a receipt (a receipt
 * block cannot be sent at all). A unit whose owner and tenant have no account
 * that may see this kind is reported in `unidadesSinDestinatario`, never an
 * error.
 *
 * Trade-off, stated plainly: the progress is written after the send, so a crash
 * in the instant between the provider accepting an email and the write can send
 * that one email twice on resume. Writing first would silently lose it instead;
 * a duplicate notice is the lesser evil.
 */
@Injectable()
export class FacturacionBloqueEntregaService {
  private readonly logger = new Logger(FacturacionBloqueEntregaService.name);

  constructor(
    @InjectModel(BloqueFacturacion.name)
    private readonly bloques: Model<BloqueFacturacionDocument>,
    @InjectModel(DocumentoBloque.name)
    private readonly documentos: Model<DocumentoBloqueDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /**
   * Sends (first time) or resumes (after a failure or a dead request) the
   * delivery of a block, and answers how far it got. The sender is the caller's
   * account, recorded once on the block; the client supplies nothing. 404 when
   * the block is not in this coproperty; 409 when it was already fully sent,
   * another request is delivering it right now, it is not processed yet, or it
   * is a receipt block.
   */
  async enviar(id: string, user: IRequestUser): Promise<BloqueContrato> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Bloque ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const token = randomUUID();
    const bloque = await this.reclamar(id, copropiedadId, token, user);

    try {
      await this.entregar(bloque, copropiedadId, token);
    } catch (error: unknown) {
      // Release the lease so the next call can resume at once instead of
      // waiting for it to expire.
      await this.soltar(bloque._id, copropiedadId, token);
      throw error;
    }

    const actual = await this.bloques
      .findOne({ _id: bloque._id, copropiedadId })
      .exec();
    if (!actual) throw new NotFoundException(`Bloque ${id} no encontrado`);
    return toBloque(actual, await this.contar(actual, copropiedadId));
  }

  /**
   * Takes the delivery lease with ONE atomic update, so two concurrent requests
   * cannot both win. Claimable: a `generado` block, or a `pendiente_envio` one
   * whose holder stopped renewing. Receipt blocks are excluded in the filter
   * itself. The sender and the time are stamped only the FIRST time
   * (`$ifNull`/`$cond`), which needs an aggregation-pipeline update; the name is
   * wrapped in `$literal` so a name starting with `$` is data, not a field path.
   */
  private async reclamar(
    id: string,
    copropiedadId: Types.ObjectId,
    token: string,
    user: IRequestUser,
  ): Promise<BloqueFacturacionDocument> {
    const ahora = new Date();
    const limite = new Date(ahora.getTime() - VIGENCIA_ENVIO_MS);
    const cuenta =
      user.accountId && Types.ObjectId.isValid(user.accountId)
        ? new Types.ObjectId(user.accountId)
        : null;
    const sinEnviar = {
      $eq: [{ $ifNull: ['$enviadoEn', null] }, null],
    };
    const reclamado = await this.bloques
      .findOneAndUpdate(
        {
          _id: id,
          copropiedadId,
          tipo: { $in: [...TIPOS_DE_RESIDENTE] },
          $or: [
            { estado: 'generado' },
            {
              estado: 'pendiente_envio',
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
              estado: 'pendiente_envio',
              tokenEnvio: token,
              envioIniciadoEn: ahora,
              enviadoEn: { $ifNull: ['$enviadoEn', ahora] },
              enviadoPorId: {
                $cond: [sinEnviar, { $literal: cuenta }, '$enviadoPorId'],
              },
              enviadoPorNombre: {
                $cond: [
                  sinEnviar,
                  { $literal: user.nombre ?? '' },
                  '$enviadoPorNombre',
                ],
              },
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
    const existente = await this.bloques
      .findOne({ _id: id, copropiedadId })
      .select('estado tipo')
      .exec();
    if (!existente) throw new NotFoundException(`Bloque ${id} no encontrado`);
    if (!(TIPOS_DE_RESIDENTE as readonly string[]).includes(existente.tipo)) {
      throw new ConflictException(
        'Los bloques de recibos no se envían a los residentes.',
      );
    }
    if (existente.estado === 'enviado') {
      throw new ConflictException('Este bloque ya fue enviado.');
    }
    if (existente.estado === 'pendiente_envio') {
      throw new ConflictException(
        'Este bloque está en proceso de envío. Si se interrumpió, volvé a intentarlo en unos minutos.',
      );
    }
    throw new ConflictException(
      'Este bloque todavía no está procesado. Confirmá la subida antes de enviarlo.',
    );
  }

  /** Delivers to everyone still missing something, then settles the state. */
  private async entregar(
    bloque: BloqueFacturacionDocument,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<void> {
    const documentos = await this.documentos
      .find({ copropiedadId, bloqueId: bloque._id })
      .exec();
    const residentes = await this.directorio.residentesDeInmuebles(
      copropiedadId,
      documentos.map((d) => d.inmuebleId),
    );
    // `findById` is allowed here: the id IS the tenant.
    const copropiedad = await this.copropiedades
      .findById(copropiedadId)
      .select('nombre')
      .exec();

    const contexto: ContextoEntrega = {
      bloque,
      copropiedadId,
      nombreCopropiedad: copropiedad?.nombre ?? '',
      correoConfigurado: this.correo.estaConfigurado(),
      notificados: new Map(
        documentos.map((d) => [
          d._id.toString(),
          new Set(d.notificadosIds.map(String)),
        ]),
      ),
      enviados: new Map(
        documentos.map((d) => [
          d._id.toString(),
          new Set(d.correosEnviadosIds.map(String)),
        ]),
      ),
    };
    if (!contexto.correoConfigurado) {
      this.logger.warn(
        `Bloque ${bloque._id.toString()}: el correo no está configurado; solo se crean las notificaciones dentro de la app.`,
      );
    }

    // Who is entitled to what, decided by the SAME rule the portal applies.
    const entregas: Entrega[] = [];
    const sinDestinatario: string[] = [];
    for (const documento of documentos) {
      const elegibles = this.sinRepetidos(
        (residentes.get(documento.inmuebleId.toString()) ?? []).filter((r) =>
          puedeVerTipo(r.rol, documento.tipo),
        ),
      );
      if (elegibles.length === 0) {
        sinDestinatario.push(documento.codigoInmueble);
      }
      for (const residente of elegibles)
        entregas.push({ documento, residente });
    }

    const faltantes = entregas.filter((e) => this.leFalta(e, contexto));
    for (let i = 0; i < faltantes.length; i += ENVIOS_SIMULTANEOS) {
      await Promise.all(
        faltantes
          .slice(i, i + ENVIOS_SIMULTANEOS)
          .map((entrega) => this.entregarA(entrega, contexto)),
      );
      // Renew the lease. No match means the block was deleted or another request
      // took over after ours stalled: stop, it is not ours any more.
      if (!(await this.latido(bloque._id, copropiedadId, token))) return;
    }

    const completo = entregas.every((e) => !this.leFalta(e, contexto, true));
    await this.bloques
      .updateOne(
        { _id: bloque._id, copropiedadId, tokenEnvio: token },
        {
          $set: {
            estado: completo ? 'enviado' : 'pendiente_envio',
            destinatariosTotal: entregas.length,
            correoConfigurado: contexto.correoConfigurado,
            unidadesSinDestinatario: sinDestinatario.sort(),
            tokenEnvio: null,
            envioIniciadoEn: null,
          },
        },
      )
      .exec();
  }

  /** The same account twice for one unit would get one notice twice. */
  private sinRepetidos(
    residentes: ResidenteDeInmueble[],
  ): ResidenteDeInmueble[] {
    return [...new Map(residentes.map((r) => [r.accountId, r])).values()];
  }

  /**
   * Whether this delivery still lacks something. With `final` the email counts
   * as missing even when the environment cannot send it: a block is only
   * `enviado` when everything really went out, never by faking it.
   */
  private leFalta(
    entrega: Entrega,
    contexto: ContextoEntrega,
    final = false,
  ): boolean {
    const documento = entrega.documento._id.toString();
    const cuenta = entrega.residente.accountId;
    if (!contexto.notificados.get(documento)?.has(cuenta)) return true;
    if (contexto.enviados.get(documento)?.has(cuenta)) return false;
    return final || contexto.correoConfigurado;
  }

  /**
   * One delivery: the in-app entry (if missing), then the email (if missing and
   * the environment can send it). Never throws, so one bad recipient cannot stop
   * the others; whatever failed simply stays unrecorded and pending.
   */
  private async entregarA(
    { documento, residente }: Entrega,
    contexto: ContextoEntrega,
  ): Promise<void> {
    const { bloque, copropiedadId } = contexto;
    const idDocumento = documento._id.toString();
    // Account id, never the address: the log is not a place for personal data.
    const etiqueta = `${idDocumento} a la cuenta ${residente.accountId}`;
    try {
      if (!contexto.notificados.get(idDocumento)?.has(residente.accountId)) {
        const guardada = await this.notificaciones.crear({
          copropiedadId,
          accountId: residente.accountId,
          tipo: 'pago',
          titulo: construirAsuntoBloque(bloque.tipo, bloque.periodo),
        });
        // Not stored = still pending: the next send retries it.
        if (guardada) {
          await this.registrar(
            contexto,
            documento,
            'notificadosIds',
            residente.accountId,
          );
          contexto.notificados.get(idDocumento)?.add(residente.accountId);
        }
      }

      if (
        contexto.correoConfigurado &&
        !contexto.enviados.get(idDocumento)?.has(residente.accountId)
      ) {
        const enlace = await this.enlaces.construir(
          residente.accountId,
          copropiedadId.toString(),
          `/portal/mis-documentos?abrir=${idDocumento}`,
          VIGENCIA_ENLACE_MS,
        );
        const { asunto, html } = construirCorreoBloque({
          nombreDestinatario: residente.nombre,
          nombreCopropiedad: contexto.nombreCopropiedad,
          tipo: bloque.tipo,
          periodo: bloque.periodo,
          codigoInmueble: documento.codigoInmueble,
          enlace,
        });
        const enviado = await this.correo.enviar({
          para: residente.email,
          asunto,
          html,
        });
        if (!enviado) {
          this.logger.error(`No se pudo enviar el documento ${etiqueta}.`);
          return;
        }
        await this.registrar(
          contexto,
          documento,
          'correosEnviadosIds',
          residente.accountId,
        );
        contexto.enviados.get(idDocumento)?.add(residente.accountId);
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo entregar el documento ${etiqueta}: ${(error as Error).message}`,
      );
    }
  }

  /** Records one recipient as delivered. Idempotent: `$addToSet` never duplicates. */
  private async registrar(
    contexto: ContextoEntrega,
    documento: DocumentoBloqueDocument,
    campo: CampoProgreso,
    accountId: string,
  ): Promise<void> {
    await this.documentos
      .updateOne(
        { _id: documento._id, copropiedadId: contexto.copropiedadId },
        { $addToSet: { [campo]: new Types.ObjectId(accountId) } },
      )
      .exec();
  }

  /** Delivery counts straight from the recorded ids, so they cannot drift from what was sent. */
  private async contar(
    bloque: BloqueFacturacionDocument,
    copropiedadId: Types.ObjectId,
  ): Promise<EntregaBloque> {
    const documentos = await this.documentos
      .find({ copropiedadId, bloqueId: bloque._id })
      .select('notificadosIds correosEnviadosIds')
      .lean()
      .exec();
    return {
      destinatarios: bloque.destinatariosTotal,
      notificados: documentos.reduce((n, d) => n + d.notificadosIds.length, 0),
      correosEnviados: documentos.reduce(
        (n, d) => n + d.correosEnviadosIds.length,
        0,
      ),
      correoConfigurado: bloque.correoConfigurado,
    };
  }

  /** Renews the lease; false when this request no longer owns the block. */
  private async latido(
    id: Types.ObjectId,
    copropiedadId: Types.ObjectId,
    token: string,
  ): Promise<boolean> {
    const resultado = await this.bloques
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
      await this.bloques
        .updateOne(
          { _id: id, copropiedadId, tokenEnvio: token },
          { $set: { tokenEnvio: null, envioIniciadoEn: null } },
        )
        .exec();
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo liberar el envío del bloque ${id.toString()}: ${(error as Error).message}`,
      );
    }
  }
}
