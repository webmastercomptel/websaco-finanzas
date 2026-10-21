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
import {
  LoteFacturacion,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import type { LoteFacturasPdfConfirmadoEvent } from '../../common/eventos/lote-facturas-pdf-confirmado.event';
import { construirPayload, periodoDeLote } from './publicacion-facturas.mapper';
import { firmar } from './publicacion-facturas.firma';
import {
  CLAIM_TTL_MS,
  FETCH_TIMEOUT_MS,
  LOTE_MAXIMO_POR_CICLO,
  MARGEN_CICLO_MS,
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
 *  `urlSigned` or any response body, only a short `ultimoError` code. */
export interface Desenlace {
  estado: 'enviado' | 'fallido';
  reintentable: boolean;
  proximoIntentoEn: Date | null;
  ultimoCodigoEstado: number | null;
  ultimoError: string | null;
  enviadoEn: Date | null;
}

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
    @InjectModel(LoteFacturacion.name)
    private readonly lotes: Model<LoteFacturacionDocument>,
  ) {}

  /**
   * Creates an idempotent outbox row for `evento.loteId`, only when the
   * batch's coproperty has the flag on AND a `websaco3CopropiedadId` on file.
   * A flag-on coproperty with no id is a legacy state nothing can fix
   * retroactively — it is skipped with a warning rather than enqueuing a row
   * this service could never actually send.
   *
   * Returns whether the row EXISTS after the call (`true` on a fresh upsert
   * AND on an 11000 race, where a concurrent call already inserted it), so
   * the listener can dispatch it right away; `false` means there is nothing
   * to send. The id is only checked here, never copied onto the row — `procesar`
   * resolves it from the live `Copropiedad` on every attempt.
   */
  async encolar(evento: LoteFacturasPdfConfirmadoEvent): Promise<boolean> {
    const copropiedad = await this.copropiedades
      .findById(evento.copropiedadId)
      .select('usaGestionEdificios websaco3CopropiedadId')
      .lean()
      .exec();

    if (!copropiedad?.usaGestionEdificios) return false;

    if (!copropiedad.websaco3CopropiedadId) {
      this.logger.warn(
        `La copropiedad ${evento.copropiedadId} tiene la gestión de edificios activa pero sin ID de WebSaco3; se omite la publicación del lote ${evento.loteId}.`,
      );
      return false;
    }

    try {
      await this.filas
        .updateOne(
          { loteId: new Types.ObjectId(evento.loteId) },
          {
            $setOnInsert: {
              copropiedadId: new Types.ObjectId(evento.copropiedadId),
              loteId: new Types.ObjectId(evento.loteId),
              numerosFactura: evento.numerosFactura,
              objectPath: evento.objectPath,
              estado: 'pendiente',
              reintentable: true,
              intentos: 0,
              proximoIntentoEn: new Date(),
              reclamadoEn: null,
              tokenReclamo: null,
              ultimoCodigoEstado: null,
              ultimoError: null,
              enviadoEn: null,
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
    return true;
  }

  /**
   * Atomically claims ONE eligible row: due `pendiente`/reintentable-`fallido`,
   * OR a stale `enviando` row whose claim is older than `CLAIM_TTL_MS`
   * (crash recovery). `intentos` is incremented as part of the SAME atomic
   * update, so a crash loop that never reaches `liberar` still counts
   * toward `max`.
   *
   * With `loteId`, only THAT lote's row can be claimed (immediate dispatch
   * from the confirm request). It narrows the sweep's predicate, never
   * replaces it, so it is the same atomic claim: a row that is already
   * claimed, sent, exhausted or not yet due yields `null`.
   */
  async reclamar(max: number, loteId?: string): Promise<FilaReclamada | null> {
    const ahora = new Date();
    const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);

    return this.filas
      .findOneAndUpdate(
        {
          ...(loteId ? { loteId: new Types.ObjectId(loteId) } : {}),
          intentos: { $lt: max },
          $or: [
            {
              estado: { $in: ['pendiente', 'fallido'] },
              reintentable: true,
              proximoIntentoEn: { $lte: ahora },
            },
            { estado: 'enviando', reclamadoEn: { $lte: vencido } },
          ],
        },
        {
          $set: {
            estado: 'enviando',
            reclamadoEn: ahora,
            tokenReclamo: randomUUID(),
          },
          $inc: { intentos: 1 },
        },
        { sort: { proximoIntentoEn: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec();
  }

  /**
   * Sends one claimed row: resolves the WebSaco3 id from the CURRENT
   * `Copropiedad`, then a fresh signed read URL (never reused across
   * attempts), the pure payload/HMAC, then `fetch` with a hard timeout.
   * Returns the outcome for `liberar` to persist — never logs `urlSigned`
   * or any response body, only short codes.
   *
   * The id is read here, on every attempt, instead of being snapshotted at
   * enqueue: a corrected id then reaches rows already queued. It is read
   * BEFORE signing anything, so a coproperty with no id costs no signed URL
   * and no request. `Copropiedad` IS the tenant, so `findById` is the right
   * lookup here (the tenancy law's `findById` warning is about other
   * collections). The lote's `periodoDesde` is read the same way and for the
   * same reason (see the `periodo` block below).
   */
  private async procesar(fila: FilaReclamada, max: number): Promise<Desenlace> {
    let websaco3CopropiedadId: string | null;
    try {
      const copropiedad = await this.copropiedades
        .findById(fila.copropiedadId)
        .select('usaGestionEdificios websaco3CopropiedadId')
        .lean()
        .exec();
      // Flag off, unknown coproperty and flag on with no id are the same
      // dead end: there is nothing to send and no retry can create it.
      websaco3CopropiedadId = copropiedad?.usaGestionEdificios
        ? (copropiedad.websaco3CopropiedadId ?? null)
        : null;
    } catch (err) {
      // Must be caught: a throw would leave the row `enviando` until
      // CLAIM_TTL_MS expires. Transient, so it follows the retry policy.
      this.logger.warn(
        `No se pudo leer la copropiedad del lote ${fila.loteId.toString()}: ${(err as Error).message}`,
      );
      return this.desenlaceReintentar(fila, max, null, 'copropiedad-lectura');
    }

    if (!websaco3CopropiedadId) {
      this.logger.warn(
        `El lote ${fila.loteId.toString()} no se puede publicar: la copropiedad no tiene gestión de edificios activa o carece de ID de WebSaco3.`,
      );
      return {
        estado: 'fallido',
        reintentable: false,
        proximoIntentoEn: null,
        ultimoCodigoEstado: null,
        ultimoError: 'sin-websaco3-id',
        enviadoEn: null,
      };
    }

    // Month the lote bills, read at send time like the coproperty id so rows
    // already queued carry it too. Only a failed READ is an error; a lote that
    // is gone or has no usable date just omits `periodo` (the receiver falls
    // back on its month of receipt) — a cosmetic field never blocks a lote.
    // Tenant-scoped `findOne`, never a bare `findById`, per the tenancy law.
    let periodo: string | undefined;
    try {
      const lote = await this.lotes
        .findOne({ _id: fila.loteId, copropiedadId: fila.copropiedadId })
        .select('periodoDesde')
        .lean()
        .exec();
      periodo = periodoDeLote(lote?.periodoDesde);
    } catch (err) {
      this.logger.warn(
        `No se pudo leer el lote ${fila.loteId.toString()}: ${(err as Error).message}`,
      );
      return this.desenlaceReintentar(fila, max, null, 'lote-lectura');
    }

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

    const payload = construirPayload(
      fila,
      websaco3CopropiedadId,
      urlSigned,
      expiresAt,
      periodo,
    );
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
        // WebSaco3's receiver is a JSON API endpoint; it has no business
        // redirecting a POST. Treat a 3xx as a hard failure (same bucket as
        // a network error, retried under the normal backoff/max policy)
        // instead of letting undici silently follow it — a followed
        // 301/302/303 downgrades POST to GET and drops the signed body.
        redirect: 'error',
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

    // Every outcome below is derived from the status code alone — the body
    // is never read. Cancel it so undici can release the underlying
    // connection instead of holding it open until GC.
    void respuesta.body?.cancel().catch(() => {});

    const clasificacion = clasificarRespuesta(respuesta.status);

    if (clasificacion === 'enviado') {
      this.logger.log(
        `Lote ${fila.loteId.toString()} publicado en WebSaco3 (HTTP ${respuesta.status}).`,
      );
      return {
        estado: 'enviado',
        reintentable: false,
        proximoIntentoEn: null,
        ultimoCodigoEstado: respuesta.status,
        ultimoError: null,
        enviadoEn: new Date(),
      };
    }

    if (clasificacion === 'terminal') {
      this.logger.warn(
        `Lote ${fila.loteId.toString()} rechazado de forma terminal (HTTP ${respuesta.status}).`,
      );
      return {
        estado: 'fallido',
        reintentable: false,
        proximoIntentoEn: null,
        ultimoCodigoEstado: respuesta.status,
        ultimoError: `HTTP ${respuesta.status}`,
        enviadoEn: null,
      };
    }

    return this.desenlaceReintentar(
      fila,
      max,
      respuesta.status,
      `HTTP ${respuesta.status}`,
    );
  }

  /** Builds a retry-branch outcome: terminal once `intentos` (already
   *  incremented by `reclamar`) reaches `max`, otherwise scheduled with
   *  exponential backoff. */
  private desenlaceReintentar(
    fila: FilaReclamada,
    max: number,
    ultimoCodigoEstado: number | null,
    ultimoError: string,
  ): Desenlace {
    const agotado = fila.intentos >= max;
    if (agotado) {
      return {
        estado: 'fallido',
        reintentable: false,
        proximoIntentoEn: null,
        ultimoCodigoEstado,
        ultimoError,
        enviadoEn: null,
      };
    }
    return {
      estado: 'fallido',
      reintentable: true,
      proximoIntentoEn: new Date(Date.now() + retrasoTras(fila.intentos)),
      ultimoCodigoEstado,
      ultimoError,
      enviadoEn: null,
    };
  }

  /**
   * Releases a claimed row with its outcome — conditional on `tokenReclamo`
   * so a stale re-claim (the row's claim expired and a later cycle already
   * reclaimed it) can never have its outcome overwritten by the claim it
   * superseded. `modifiedCount === 0` means exactly that happened: log and
   * write nothing.
   */
  async liberar(fila: FilaReclamada, desenlace: Desenlace): Promise<void> {
    const resultado = await this.filas
      .updateOne(
        { _id: fila._id, tokenReclamo: fila.tokenReclamo },
        { $set: { ...desenlace, reclamadoEn: null, tokenReclamo: null } },
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
   * `pendiente`/`fallido` row whose `intentos` already meets a `max` that
   * was LOWERED since it last ran also gets closed out.
   */
  async barrerAgotados(max: number): Promise<void> {
    const ahora = new Date();
    const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);

    await Promise.all([
      this.filas
        .updateMany(
          {
            estado: 'enviando',
            reclamadoEn: { $lte: vencido },
            intentos: { $gte: max },
          },
          {
            $set: {
              estado: 'fallido',
              reintentable: false,
              reclamadoEn: null,
              tokenReclamo: null,
              ultimoError: 'reclamo-expirado',
            },
          },
        )
        .exec(),
      this.filas
        .updateMany(
          {
            estado: { $in: ['pendiente', 'fallido'] },
            reintentable: true,
            intentos: { $gte: max },
          },
          { $set: { estado: 'fallido', reintentable: false } },
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

        if (desenlace.estado === 'enviado') resumen.enviadas += 1;
        else if (desenlace.reintentable) resumen.reintentar += 1;
        else resumen.terminales += 1;
      }
      return resumen;
    } finally {
      this.enEjecucion = false;
    }
  }

  /**
   * Immediate dispatch for ONE lote, awaited by the listener inside the
   * confirm-PDF request (Cloud Run throttles CPU once the response is sent,
   * so a fire-and-forget send would stall). No-op when the transport is not
   * configured: the row stays `pendiente` for the manual sweep.
   *
   * It claims that lote's row through the same atomic `reclamar` the sweep
   * uses, then `procesar` + `liberar`. There is deliberately NO `enEjecucion`
   * lock: that flag serialises whole sweep cycles on one instance, and a
   * confirm request must never be refused (or refuse a sweep) because of it.
   * The atomic claim alone prevents a double send: a `null` claim means the
   * row is already sent, being sent by someone else, exhausted or not due.
   *
   * It does not catch: the listener owns the catch-all. If `liberar` throws
   * after the send, the row stays `enviando` until `CLAIM_TTL_MS` and the
   * sweep re-claims it (a re-send the receiver dedupes by `loteId`, 409).
   */
  async publicarAhora(loteId: string): Promise<void> {
    if (!this.transporteConfigurado()) return;

    const max = this.maxIntentos();
    const fila = await this.reclamar(max, loteId);
    if (!fila) return;

    const desenlace = await this.procesar(fila, max);
    await this.liberar(fila, desenlace);
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
