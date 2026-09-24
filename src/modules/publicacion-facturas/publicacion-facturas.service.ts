// src/modules/publicacion-facturas/publicacion-facturas.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  PublicacionLote,
  PublicacionLoteDocument,
} from '../../database/schemas/publicaciones/publicacion-lote.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import type { LoteFacturasPdfConfirmadoEvent } from '../../common/eventos/lote-facturas-pdf-confirmado.event';
import { construirPayload } from './publicacion-facturas.mapper';
import { firmar } from './publicacion-facturas.firma';
import {
  CLAIM_TTL_MS,
  FETCH_TIMEOUT_MS,
  LOTE_MAXIMO_POR_CICLO,
  PRESUPUESTO_CICLO_MS,
  URL_LECTURA_TTL_MS,
  clasificarRespuesta,
  retrasoTras,
} from './publicacion-facturas.politica';
import type { ResumenCiclo } from './publicacion-facturas.contrato';

/** What `reclamar` hands to `procesar`/`liberar` — a lean claimed row.
 *  Exported for test use only (`procesar` is private and exercised through
 *  a typed cast — see `publicacion-facturas.service.spec.ts`). */
export type FilaReclamada = PublicacionLote & { _id: Types.ObjectId };

/** What `procesar` decides and `liberar` persists — never includes
 *  `urlSigned` or any response body, only a short `lastError` code. */
export interface Desenlace {
  status: 'enviado' | 'fallido';
  retryable: boolean;
  nextAttemptAt: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  sentAt: Date | null;
}

/** Margin added to FETCH_TIMEOUT_MS when deciding whether the cycle has
 *  room left to claim one more row — covers URL signing plus the claim's
 *  own round trip, which aren't captured by FETCH_TIMEOUT_MS alone. */
const MARGEN_CICLO_MS = 5_000;

const CICLO_VACIO: ResumenCiclo = {
  omitido: false,
  reclamadas: 0,
  enviadas: 0,
  reintentar: 0,
  terminales: 0,
};

/**
 * Owns the outbox lifecycle for `invoice-batch-publication`: enqueue on the
 * domain event, atomically claim eligible rows, send with a fresh signed
 * URL and an HMAC signature, and release with the outcome. See
 * `design.md`'s "Data Flow"/"State Machine"/"Policy" sections — this class
 * implements them exactly; nothing here should diverge from that design
 * without a documented reason.
 */
@Injectable()
export class PublicacionFacturasService {
  private readonly logger = new Logger(PublicacionFacturasService.name);

  /** Same-instance overlap guard — a second `procesarPendientes()` call
   *  while one is already running returns immediately with `omitido: true`.
   *  Cross-instance overlap is already safe through the atomic claim in
   *  `reclamar`. */
  private enEjecucion = false;

  constructor(
    @InjectModel(PublicacionLote.name)
    private readonly filas: Model<PublicacionLoteDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly storage: DocumentoStorageService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Creates an idempotent outbox row for `evento.loteId`, only when the
   * batch's coproperty has the flag on AND a NIT on file. A flag-on
   * coproperty with no NIT is a legacy state `building-management-activation`
   * cannot retroactively fix — it is skipped with a warning rather than
   * enqueuing a row this service could never actually send.
   */
  async encolar(evento: LoteFacturasPdfConfirmadoEvent): Promise<void> {
    const copropiedad = await this.copropiedades
      .findById(evento.coPropertyId)
      .select('usesBuildingManagement taxId')
      .lean()
      .exec();

    if (!copropiedad?.usesBuildingManagement) return;

    if (!copropiedad.taxId) {
      this.logger.warn(
        `La copropiedad ${evento.coPropertyId} tiene la gestión de edificios activa pero sin NIT; se omite la publicación del lote ${evento.loteId}.`,
      );
      return;
    }

    try {
      await this.filas
        .updateOne(
          { loteId: new Types.ObjectId(evento.loteId) },
          {
            $setOnInsert: {
              coPropertyId: new Types.ObjectId(evento.coPropertyId),
              loteId: new Types.ObjectId(evento.loteId),
              taxId: copropiedad.taxId,
              invoiceNumbers: evento.numerosFactura,
              objectPath: evento.objectPath,
              status: 'pendiente',
              retryable: true,
              attempts: 0,
              nextAttemptAt: new Date(),
              claimedAt: null,
              claimToken: null,
              lastStatusCode: null,
              lastError: null,
              sentAt: null,
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // A concurrent upsert for the same loteId already won the insert race
      // — the row exists either way, so this is a no-op, not a failure.
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  /**
   * Atomically claims ONE eligible row: due `pendiente`/retryable-`fallido`,
   * OR a stale `enviando` row whose claim is older than `CLAIM_TTL_MS`
   * (crash recovery). `attempts` is incremented as part of the SAME atomic
   * update, so a crash loop that never reaches `liberar` still counts
   * toward `max`.
   */
  async reclamar(max: number): Promise<FilaReclamada | null> {
    const ahora = new Date();
    const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);

    return this.filas
      .findOneAndUpdate(
        {
          attempts: { $lt: max },
          $or: [
            {
              status: { $in: ['pendiente', 'fallido'] },
              retryable: true,
              nextAttemptAt: { $lte: ahora },
            },
            { status: 'enviando', claimedAt: { $lte: vencido } },
          ],
        },
        {
          $set: {
            status: 'enviando',
            claimedAt: ahora,
            claimToken: randomUUID(),
          },
          $inc: { attempts: 1 },
        },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec();
  }

  /**
   * Sends one claimed row: a fresh signed read URL (never reused across
   * attempts), the pure payload/HMAC, then `fetch` with a hard timeout.
   * Returns the outcome for `liberar` to persist — never logs `urlSigned`
   * or any response body, only short codes.
   */
  private async procesar(fila: FilaReclamada, max: number): Promise<Desenlace> {
    let urlSigned: string;
    let expiresAt: Date;
    try {
      const urlLectura = await this.storage.generarUrlLectura(
        fila.objectPath,
        URL_LECTURA_TTL_MS,
      );
      urlSigned = urlLectura.url;
      expiresAt = urlLectura.expiresAt;
    } catch (err) {
      this.logger.warn(
        `No se pudo generar la URL de lectura del lote ${fila.loteId.toString()}: ${(err as Error).message}`,
      );
      return this.desenlaceReintentar(fila, max, null, 'url-firmada');
    }

    const payload = construirPayload(fila, urlSigned, expiresAt);
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const firma = firmar(this.hmacSecret(), timestamp, rawBody);

    let respuesta: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      respuesta = await fetch(this.endpointUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Websaco-Timestamp': timestamp,
          'X-Websaco-Signature': `sha256=${firma}`,
        },
        body: rawBody,
        signal: controller.signal,
      });
    } catch (err) {
      const motivo = (err as Error).name === 'AbortError' ? 'timeout' : 'red';
      this.logger.warn(
        `Envío del lote ${fila.loteId.toString()} falló (${motivo}).`,
      );
      return this.desenlaceReintentar(fila, max, null, motivo);
    } finally {
      clearTimeout(timeoutId);
    }

    const clasificacion = clasificarRespuesta(respuesta.status);

    if (clasificacion === 'enviado') {
      this.logger.log(
        `Lote ${fila.loteId.toString()} publicado en WebSaco3 (HTTP ${respuesta.status}).`,
      );
      return {
        status: 'enviado',
        retryable: false,
        nextAttemptAt: null,
        lastStatusCode: respuesta.status,
        lastError: null,
        sentAt: new Date(),
      };
    }

    if (clasificacion === 'terminal') {
      this.logger.warn(
        `Lote ${fila.loteId.toString()} rechazado de forma terminal (HTTP ${respuesta.status}).`,
      );
      return {
        status: 'fallido',
        retryable: false,
        nextAttemptAt: null,
        lastStatusCode: respuesta.status,
        lastError: `HTTP ${respuesta.status}`,
        sentAt: null,
      };
    }

    return this.desenlaceReintentar(
      fila,
      max,
      respuesta.status,
      `HTTP ${respuesta.status}`,
    );
  }

  /** Builds a retry-branch outcome: terminal once `attempts` (already
   *  incremented by `reclamar`) reaches `max`, otherwise scheduled with
   *  exponential backoff. */
  private desenlaceReintentar(
    fila: FilaReclamada,
    max: number,
    lastStatusCode: number | null,
    lastError: string,
  ): Desenlace {
    const agotado = fila.attempts >= max;
    if (agotado) {
      return {
        status: 'fallido',
        retryable: false,
        nextAttemptAt: null,
        lastStatusCode,
        lastError,
        sentAt: null,
      };
    }
    return {
      status: 'fallido',
      retryable: true,
      nextAttemptAt: new Date(Date.now() + retrasoTras(fila.attempts)),
      lastStatusCode,
      lastError,
      sentAt: null,
    };
  }

  /**
   * Releases a claimed row with its outcome — conditional on `claimToken`
   * so a stale re-claim (the row's claim expired and a later cycle already
   * reclaimed it) can never have its outcome overwritten by the claim it
   * superseded. `modifiedCount === 0` means exactly that happened: log and
   * write nothing.
   */
  async liberar(fila: FilaReclamada, desenlace: Desenlace): Promise<void> {
    const resultado = await this.filas
      .updateOne(
        { _id: fila._id, claimToken: fila.claimToken },
        { $set: { ...desenlace, claimedAt: null, claimToken: null } },
      )
      .exec();

    if (resultado.modifiedCount === 0) {
      this.logger.warn(
        `El reclamo del lote ${fila.loteId.toString()} ya no era vigente al liberarlo; no se escribió nada.`,
      );
    }
  }

  /**
   * Two sweeps run at the start of every cycle: expired `enviando` claims
   * that already exhausted `max` go straight to terminal `fallido` (instead
   * of being re-claimed only to immediately exhaust there), and any
   * `pendiente`/`fallido` row whose `attempts` already meets a `max` that
   * was LOWERED since it last ran also gets closed out.
   */
  async barrerAgotados(max: number): Promise<void> {
    const ahora = new Date();
    const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);

    await Promise.all([
      this.filas
        .updateMany(
          {
            status: 'enviando',
            claimedAt: { $lte: vencido },
            attempts: { $gte: max },
          },
          {
            $set: {
              status: 'fallido',
              retryable: false,
              claimedAt: null,
              claimToken: null,
              lastError: 'reclamo-expirado',
            },
          },
        )
        .exec(),
      this.filas
        .updateMany(
          {
            status: { $in: ['pendiente', 'fallido'] },
            retryable: true,
            attempts: { $gte: max },
          },
          { $set: { status: 'fallido', retryable: false } },
        )
        .exec(),
    ]);
  }

  /**
   * One triggered cycle: no-op when the transport isn't configured, `omitido`
   * on same-instance overlap, otherwise sweeps expired claims and then
   * claims/sends/releases rows up to `LOTE_MAXIMO_POR_CICLO`, stopping early
   * once the remaining time budget could not fit one more attempt. Always
   * resolves — row-level failures live in the outbox, not in this return.
   */
  async procesarPendientes(): Promise<ResumenCiclo> {
    if (!this.transporteConfigurado()) return { ...CICLO_VACIO };
    if (this.enEjecucion) return { ...CICLO_VACIO, omitido: true };

    this.enEjecucion = true;
    const inicio = Date.now();
    try {
      const max = this.maxIntentos();
      await this.barrerAgotados(max);

      const resumen: ResumenCiclo = { ...CICLO_VACIO };
      for (let i = 0; i < LOTE_MAXIMO_POR_CICLO; i += 1) {
        const transcurrido = Date.now() - inicio;
        if (
          transcurrido + FETCH_TIMEOUT_MS + MARGEN_CICLO_MS >
          PRESUPUESTO_CICLO_MS
        ) {
          break;
        }

        const fila = await this.reclamar(max);
        if (!fila) break;
        resumen.reclamadas += 1;

        const desenlace = await this.procesar(fila, max);
        await this.liberar(fila, desenlace);

        if (desenlace.status === 'enviado') resumen.enviadas += 1;
        else if (desenlace.retryable) resumen.reintentar += 1;
        else resumen.terminales += 1;
      }
      return resumen;
    } finally {
      this.enEjecucion = false;
    }
  }

  private transporteConfigurado(): boolean {
    return Boolean(this.endpointUrlOrNull() && this.hmacSecretOrNull());
  }

  private endpointUrlOrNull(): string | undefined {
    return this.config.get<string>('app.websaco3FacturasEndpointUrl');
  }

  private endpointUrl(): string {
    // Safe: only called once transporteConfigurado() confirmed presence.
    return this.endpointUrlOrNull()!;
  }

  private hmacSecretOrNull(): string | undefined {
    return this.config.get<string>('app.websaco3HmacSecret');
  }

  private hmacSecret(): string {
    return this.hmacSecretOrNull()!;
  }

  private maxIntentos(): number {
    return this.config.get<number>('app.websaco3PublicacionMaxIntentos')!;
  }
}
