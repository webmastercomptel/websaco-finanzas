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
 * How long the access link of the notice works: 7 days, like every other access
 * link. It is reusable until then and it opens the OWNER's session, statement of
 * account included, so any forwarded or archived copy of the email is a
 * credential for that long. After it expires the resident signs in normally
 * ("forgot password") or staff sends again. Still refused for anybody holding a
 * Finanzas permission (see `EnlaceAccesoService`).
 */
export const VIGENCIA_ENLACE_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Queued rows that are only waiting out their retry backoff: no live lease, but
 * `proximoIntentoEn` is still in the future. The complement of
 * {@link filtroReclamable} among the rows without a live lease, so a row is in
 * exactly one of "claimable", "waiting" or "held by a live processor".
 */
export const filtroEnEspera = (
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
    { proximoIntentoEn: { $gt: ahora } },
  ],
});

/** The queue split three ways; the three numbers always add up to the queued rows. */
export interface ConteoCola {
  /** Ready to be processed right now. */
  pendientes: number;
  /** Held by a live processor (a lease still inside its validity). */
  enCurso: number;
  /** Only waiting out their retry backoff; nobody holds them. */
  enEspera: number;
}

/** Minimal shape of the model needed to count the queue (keeps this file free of Mongoose). */
interface ContableCola {
  countDocuments(filtro: Record<string, unknown>): {
    exec(): Promise<number>;
  };
}

/**
 * Counts the queue of a coproperty in the three buckets above. `enCurso` is the
 * remainder, so a row with a live lease AND a pending backoff counts as held
 * (the lease is what stops anybody from taking it), never twice.
 */
export async function contarCola(
  envios: ContableCola,
  copropiedadId: Types.ObjectId,
  ahora: Date,
): Promise<ConteoCola> {
  const [pendientes, enEspera, enCola] = await Promise.all([
    envios.countDocuments(filtroReclamable(copropiedadId, ahora)).exec(),
    envios.countDocuments(filtroEnEspera(copropiedadId, ahora)).exec(),
    envios.countDocuments({ copropiedadId, estado: 'pendiente_envio' }).exec(),
  ]);
  return { pendientes, enEspera, enCurso: enCola - pendientes - enEspera };
}
