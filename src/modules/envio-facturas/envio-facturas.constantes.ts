// src/modules/envio-facturas/envio-facturas.constantes.ts
import type { Types } from 'mongoose';

/**
 * How many rows are delivered at once. The host only has CPU while a request is
 * open, so delivery is awaited inside it; this bounds the burst against the mail
 * provider and Mongo instead of firing hundreds of sends together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/** Rows one processing call takes at most (a few batches fit well inside 300 s). */
export const LIMITE_POR_LLAMADA = 50;

/**
 * Time after which a call stops STARTING new batches and answers with what it did
 * (the screen calls again). Cloud Run gives a request 300 s and the batch in
 * flight still has to finish, so this leaves a wide margin.
 */
export const PRESUPUESTO_MS = 150 * 1000;

/**
 * How long a lease lives without a heartbeat. The holder renews it after every
 * batch, so a live request never loses it; a request that died (instance killed
 * mid-send) leaves it to expire, after which the rows can be claimed again.
 */
export const VIGENCIA_ENVIO_MS = 3 * 60 * 1000;

/** Failed attempts after which a row stops retrying and waits for a human. */
export const MAX_INTENTOS = 5;

/** Wait before the next attempt after the n-th failure: 1, 2, 4... minutes, capped at 30. */
export const esperaTrasFallo = (intentos: number): number =>
  Math.min(60_000 * 2 ** Math.max(0, intentos - 1), 30 * 60_000);

/**
 * How long the access link of the notice works: 35 days, so a notice stays usable
 * for the whole payment cycle plus a margin. The link is still refused for anybody
 * holding a Finanzas permission (see `EnlaceAccesoService`).
 */
export const VIGENCIA_ENLACE_MS = 35 * 24 * 60 * 60 * 1000;

/** Longest queue page staff can ask for. */
export const MAX_POR_PAGINA = 100;

/**
 * The rows a processor may take right now: queued, not held by a live lease and
 * past their backoff. ONE definition shared by the claim and the counters, so the
 * "pending" the screen shows is exactly what the next call would take.
 */
export const filtroReclamable = (
  copropiedadId: Types.ObjectId,
  ahora: Date,
): Record<string, unknown> => ({
  copropiedadId,
  estado: 'pendiente_envio',
  $and: [
    {
      $or: [
        { tokenEnvio: null },
        {
          envioIniciadoEn: {
            $lt: new Date(ahora.getTime() - VIGENCIA_ENVIO_MS),
          },
        },
      ],
    },
    {
      $or: [{ proximoIntentoEn: null }, { proximoIntentoEn: { $lte: ahora } }],
    },
  ],
});
