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
 *  e-mail it is about to travel in; it is never persisted. `id` and `clave`
 *  name the row for `confirmarEnvio` / `anular`. */
export interface EnlaceIngresoEmitido {
  id: Types.ObjectId;
  clave: string;
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
 *   the latest e-mail works, but only once ITS e-mail went out
 *   (`confirmarEnvio`): minting alone kills nothing, and a link whose e-mail
 *   failed is voided (`anular`) and leaves the older ones alone, so a failed
 *   send never strands the person with no working link. The newest is decided
 *   by `_id` order, a total order: of several sent links exactly the newest
 *   survives, whatever order their confirmations land in.
 *
 * Nothing here logs: the token, its hash and the address never reach a log line.
 */
@Injectable()
export class EnlaceIngresoService {
  constructor(
    @InjectModel(EnlaceIngreso.name)
    private readonly enlaces: Model<EnlaceIngresoDocument>,
  ) {}

  /**
   * Mints a link for `correo`. It kills nothing: the caller confirms it once
   * the e-mail went out (`confirmarEnvio`) or voids it (`anular`).
   */
  async crear(datos: {
    correo: string;
    origen?: OrigenEnlaceIngreso;
    solicitadoPor?: Types.ObjectId | null;
  }): Promise<EnlaceIngresoEmitido> {
    const correo = normalizarEmail(datos.correo);
    const clave = claveCorreo(correo);
    const token = randomBytes(32).toString('hex');
    const expiraEn = new Date(Date.now() + VIGENCIA_ENLACE_INGRESO_MS);
    const _id = new Types.ObjectId();

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
    return { id: _id, clave, token, expiraEn };
  }

  /**
   * The e-mail of this link went out: kill the address's OLDER unused links in
   * one atomic `updateMany` (`_id` below the new one, so the new one is never
   * touched and a later link is never killed by an earlier confirmation).
   */
  async confirmarEnvio(emitido: EnlaceIngresoEmitido): Promise<void> {
    await this.enlaces
      .updateMany(
        { clave: emitido.clave, usadoEn: null, _id: { $lt: emitido.id } },
        { $set: { usadoEn: new Date() } },
      )
      .exec();
  }

  /**
   * The e-mail of this link did not go out: mark the NEW row spent so it can
   * never be redeemed. The older links are left as they were.
   */
  async anular(emitido: EnlaceIngresoEmitido): Promise<void> {
    await this.enlaces
      .updateOne(
        { _id: emitido.id, usadoEn: null },
        { $set: { usadoEn: new Date() } },
      )
      .exec();
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
