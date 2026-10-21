// src/modules/interfaz-comptable/comptable.client.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firmarComptable } from './comptable.firma';
import {
  datosRespuestaComptable,
  leerRespuestaComptable,
  parsearCuerpo,
  type ErrorAsientoComptable,
} from './comptable.respuesta';

/**
 * Hard timeout of every call to Comptable. 60 s: a whole lote is validated
 * and written in ONE request (all or nothing), and Comptable runs on Cloud
 * Run, so a cold start (5-30 s) can precede the work itself. A timeout is not
 * a failure: the outcome is unknown, and the caller keeps the lote
 * `pendiente` so the user retries the SAME `loteOrigenId`.
 */
export const COMPTABLE_TIMEOUT_MS = 60_000;

/** `GET integraciones/websaco/empresas/:id` success payload. */
export interface EmpresaComptable {
  id: string;
  codigo: string;
  nombre: string;
  nit: string | null;
}

/** `POST …/lotes` success payload (Comptable's `ResultadoImportacionAsientos`). */
export interface ResumenLoteComptable {
  simulado: boolean;
  loteId: string | null;
  totalAsientos: number;
  totalLineas: number;
  totalDebitos: number | string;
  totalCreditos: number | string;
  tercerosNuevos: unknown[];
}

/**
 * Every way a Comptable call can end, typed so the caller has to decide what
 * each one means for its own state. Only `ok` carries Comptable's payload.
 *
 * - `rechazado` (400): the lote has errors; `errores` is shown verbatim.
 * - `duplicado` (409 `LOTE_YA_RECIBIDO`): Comptable already holds this
 *   `loteOrigenId`; the caller reconciles with `loteId` as if it were a 201.
 * - `intervenido` (409 `LOTE_INTERVENIDO`): an accountant edited the lote in
 *   Comptable, so it can no longer be withdrawn; `mensaje` is shown verbatim.
 * - `yaRetirado` (409 `LOTE_YA_RETIRADO`): Comptable already withdrew this
 *   lote; withdrawing is idempotent, so the caller treats it as success.
 * - `conflicto` (any other 409: month closed…).
 * - `noEncontrado` (404), `firma` (401/403: wrong secret or clock skew).
 * - `timeout` / `red`: outcome UNKNOWN — Comptable may have written it.
 * - `inesperado`: any other status (5xx, a proxy's 502…).
 * - `noConfigurado`: no URL/secret in this environment; no request was made.
 */
export type ResultadoComptable<T> =
  | { tipo: 'ok'; status: number; datos: T }
  | {
      tipo: 'rechazado';
      mensaje: string | null;
      errores: ErrorAsientoComptable[];
    }
  | { tipo: 'duplicado'; loteId: string | null; mensaje: string | null }
  | { tipo: 'intervenido'; mensaje: string | null }
  | { tipo: 'yaRetirado'; mensaje: string | null }
  | { tipo: 'conflicto'; mensaje: string | null }
  | { tipo: 'noEncontrado'; mensaje: string | null }
  | { tipo: 'firma' }
  | { tipo: 'timeout' }
  | { tipo: 'red' }
  | { tipo: 'inesperado'; status: number }
  | { tipo: 'noConfigurado' };

/**
 * Signed HTTP client for Comptable's `integraciones/websaco` routes. One
 * `fetch` per call, no retries (the integration is manual on purpose: the
 * user decides when to try again).
 *
 * Signs `${timestamp}.${METHOD}.${ruta}.${rawBody}` where `ruta` is the
 * pathname + query of the exact URL fetched, so Comptable's `/api/v1` prefix
 * (part of `COMPTABLE_API_URL`) is covered. The body is serialized ONCE by the
 * caller and passed here as a string, signed and sent unchanged.
 *
 * Never logs a body, the secret or a signature: only the route kind and the
 * outcome.
 */
@Injectable()
export class ComptableClient {
  private readonly logger = new Logger(ComptableClient.name);

  constructor(private readonly config: ConfigService) {}

  /** Whether this environment can talk to Comptable at all. */
  configurado(): boolean {
    return Boolean(this.baseUrl() && this.secreto());
  }

  /** Confirms an Empresa exists before a Copropiedad is linked to it. */
  consultarEmpresa(
    empresaId: string,
  ): Promise<ResultadoComptable<EmpresaComptable>> {
    return this.llamar<EmpresaComptable>(
      'GET',
      `integraciones/websaco/empresas/${encodeURIComponent(empresaId)}`,
      '',
    );
  }

  /**
   * Sends (or, with `simular`, only validates) one lote. `rawBody` is the
   * already-serialized contract v1 — the exact string signed and sent.
   */
  enviarLote(
    empresaId: string,
    rawBody: string,
    simular: boolean,
  ): Promise<ResultadoComptable<ResumenLoteComptable>> {
    return this.llamar<ResumenLoteComptable>(
      'POST',
      `integraciones/websaco/empresas/${encodeURIComponent(empresaId)}/lotes?simular=${simular ? 'true' : 'false'}`,
      rawBody,
    );
  }

  /**
   * Withdraws a lote previously sent with `loteOrigenId`. The body names the
   * user who asked (`{ solicitadoPor: { accountId, nombre } }`), so Comptable's
   * lote and audit trail say who it was; it is serialized once here and that
   * exact string is signed and sent, like a lote.
   */
  retirarLote(
    empresaId: string,
    loteOrigenId: string,
    solicitadoPor: { accountId: string; nombre: string },
  ): Promise<ResultadoComptable<unknown>> {
    const rawBody = JSON.stringify({
      solicitadoPor: {
        accountId: solicitadoPor.accountId,
        nombre: solicitadoPor.nombre,
      },
    });
    return this.llamar<unknown>(
      'POST',
      `integraciones/websaco/empresas/${encodeURIComponent(empresaId)}/lotes/${encodeURIComponent(loteOrigenId)}/retirar`,
      rawBody,
    );
  }

  private async llamar<T>(
    metodo: 'GET' | 'POST',
    camino: string,
    rawBody: string,
  ): Promise<ResultadoComptable<T>> {
    const base = this.baseUrl();
    const secreto = this.secreto();
    if (!base || !secreto) return { tipo: 'noConfigurado' };

    const url = new URL(`${base.replace(/\/+$/, '')}/${camino}`);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const firma = firmarComptable(secreto, {
      timestamp,
      metodo,
      ruta: `${url.pathname}${url.search}`,
      rawBody,
    });

    const headers: Record<string, string> = {
      'X-Websaco-Timestamp': timestamp,
      'X-Websaco-Signature': `sha256=${firma}`,
    };
    if (rawBody !== '') headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      COMPTABLE_TIMEOUT_MS,
    );
    let status: number;
    let texto: string;
    try {
      const respuesta = await fetch(url.href, {
        method: metodo,
        headers,
        ...(rawBody !== '' ? { body: rawBody } : {}),
        signal: controller.signal,
        // A JSON API has no business redirecting; following one would drop
        // the signed body (POST → GET) or sign for the wrong path.
        redirect: 'error',
      });
      status = respuesta.status;
      texto = await respuesta.text();
    } catch (err) {
      const tipo = (err as Error).name === 'AbortError' ? 'timeout' : 'red';
      this.logger.warn(
        `Comptable ${metodo} ${this.tipoRuta(camino)}: ${tipo}.`,
      );
      return { tipo };
    } finally {
      clearTimeout(timeoutId);
    }

    const resultado = this.clasificar<T>(status, parsearCuerpo(texto));
    this.logger.log(
      `Comptable ${metodo} ${this.tipoRuta(camino)}: HTTP ${status} (${resultado.tipo}).`,
    );
    return resultado;
  }

  /** Status code first; the body only adds the details of each outcome. */
  private clasificar<T>(
    status: number,
    cuerpo: unknown,
  ): ResultadoComptable<T> {
    if (status >= 200 && status < 300) {
      return {
        tipo: 'ok',
        status,
        datos: datosRespuestaComptable(cuerpo) as T,
      };
    }
    const campos = leerRespuestaComptable(cuerpo);
    switch (status) {
      case 400:
        return {
          tipo: 'rechazado',
          mensaje: campos.mensaje,
          errores: campos.errores,
        };
      case 401:
      case 403:
        return { tipo: 'firma' };
      case 404:
        return { tipo: 'noEncontrado', mensaje: campos.mensaje };
      case 409:
        if (campos.codigo === 'LOTE_YA_RECIBIDO') {
          return {
            tipo: 'duplicado',
            loteId: campos.loteId,
            mensaje: campos.mensaje,
          };
        }
        if (campos.codigo === 'LOTE_INTERVENIDO') {
          return { tipo: 'intervenido', mensaje: campos.mensaje };
        }
        if (campos.codigo === 'LOTE_YA_RETIRADO') {
          return { tipo: 'yaRetirado', mensaje: campos.mensaje };
        }
        return { tipo: 'conflicto', mensaje: campos.mensaje };
      default:
        return { tipo: 'inesperado', status };
    }
  }

  /** Route kind for the log line — never the ids or the query. */
  private tipoRuta(camino: string): string {
    if (camino.endsWith('/retirar')) return 'retirar';
    if (camino.includes('/lotes')) return 'lotes';
    return 'empresa';
  }

  private baseUrl(): string | undefined {
    return this.config.get<string>('app.comptableApiUrl');
  }

  private secreto(): string | undefined {
    return this.config.get<string>('app.comptableHmacSecret');
  }
}
