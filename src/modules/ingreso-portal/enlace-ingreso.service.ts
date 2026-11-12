// src/modules/ingreso-portal/enlace-ingreso.service.ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { claveCorreo, normalizarEmail } from '../../common/utils/email.utils';
import {
  EnlaceIngreso,
  type EnlaceIngresoDocument,
  type OrigenEnlaceIngreso,
} from '../../database/schemas/cuentas/enlace-ingreso.schema';
import {
  FORMATO_TOKEN_INGRESO,
  VIGENCIA_ENLACE_INGRESO_MS,
} from './ingreso-portal.constantes';

const hashDe = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** What `crear` hands to the mailer. `token` exists only here and in the
 *  e-mail it is about to travel in; it is never persisted. */
export interface EnlaceIngresoEmitido {
  token: string;
  expiraEn: Date;
}

/** What a successful consume tells the redeem. The address is data of the
 *  flow, never to be logged. */
export interface EnlaceIngresoConsumido {
  clave: string;
  correo: string;
  origen: OrigenEnlaceIngreso;
  solicitadoPor: Types.ObjectId | null;
}

/**
 * The public sign-in link: `<origin>/ingreso#<token>`. The token travels in the
 * fragment, so it never reaches a server log, a proxy or a `Referer`; it is
 * never put in a path or a query string.
 */
export const construirEnlaceIngreso = (
  frontendUrl: string,
  token: string,
): string => {
  const url = new URL('/ingreso', frontendUrl);
  url.hash = token;
  return url.toString();
};

/**
 * Store of the resident sign-in links (`enlaces_ingreso`): mint, invalidate,
 * consume. It decides nothing about WHO may get a link; that is the request
 * service's job. It only guarantees what a link is:
 *
 * - 32 random bytes from the CSPRNG; only the SHA-256 is stored.
 * - Valid for `VIGENCIA_ENLACE_INGRESO_MS`, checked on every consume (the TTL
 *   index is housekeeping, never the validity rule).
 * - Single use: `consumir` is ONE conditional `findOneAndUpdate`, so of any
 *   number of concurrent redeems exactly one gets the row.
 * - A newer link for an address kills that address's older unused ones, so only
 *   the latest e-mail works. The newest is decided by `_id` order, which is a
 *   total order: of several simultaneous requests exactly one survives, and no
 *   interleaving can leave two live links or zero.
 *
 * Nothing here logs: the token, its hash and the address never reach a log line.
 */
@Injectable()
export class EnlaceIngresoService {
  constructor(
    @InjectModel(EnlaceIngreso.name)
    private readonly enlaces: Model<EnlaceIngresoDocument>,
  ) {}

  /** Mints a link for `correo` and invalidates that address's earlier unused ones. */
  async crear(datos: {
    correo: string;
    origen?: OrigenEnlaceIngreso;
    solicitadoPor?: Types.ObjectId | null;
  }): Promise<EnlaceIngresoEmitido> {
    const correo = normalizarEmail(datos.correo);
    const clave = claveCorreo(correo);
    const token = randomBytes(32).toString('hex');
    const ahora = Date.now();
    const expiraEn = new Date(ahora + VIGENCIA_ENLACE_INGRESO_MS);
    const _id = new Types.ObjectId();

    // Insert FIRST, then kill the older ones: the new link is never absent
    // from the store while the old ones are already dead.
    await this.enlaces.create({
      _id,
      tokenHash: hashDe(token),
      clave,
      correo,
      origen: datos.origen ?? 'autoservicio',
      solicitadoPor: datos.solicitadoPor ?? null,
      expiraEn,
      usadoEn: null,
    });
    await this.enlaces
      .updateMany(
        { clave, usadoEn: null, _id: { $lt: _id } },
        { $set: { usadoEn: new Date(ahora) } },
      )
      .exec();

    return { token, expiraEn };
  }

  /**
   * Spends the link of `token`, or answers null for ANY reason it cannot be
   * spent (malformed, unknown, expired, already used, replaced by a newer one).
   * The only write of a redeem that must happen before every other effect.
   */
  async consumir(token: string): Promise<EnlaceIngresoConsumido | null> {
    if (!FORMATO_TOKEN_INGRESO.test(token)) return null;
    const ahora = new Date();
    const fila = await this.enlaces
      .findOneAndUpdate(
        {
          tokenHash: hashDe(token),
          usadoEn: null,
          expiraEn: { $gt: ahora },
        },
        { $set: { usadoEn: ahora } },
        { new: true },
      )
      .lean()
      .exec();
    if (!fila) return null;
    return {
      clave: fila.clave,
      correo: fila.correo,
      origen: fila.origen,
      solicitadoPor: fila.solicitadoPor ?? null,
    };
  }
}
