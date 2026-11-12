// src/modules/factura-publica/enlace-factura.service.ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EnlaceFactura,
  type EnlaceFacturaDocument,
  type RolEnlaceFactura,
} from '../../database/schemas/facturacion/enlace-factura.schema';
import { VIGENCIA_ENLACE_FACTURA_MS } from './factura-publica.constantes';

const hashDe = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** What `emitir` hands to the processor. `token` exists only here and in the
 *  e-mail it is about to travel in; it is never persisted. */
export interface EnlaceEmitido {
  id: string;
  token: string;
  expiraEn: Date;
}

/**
 * Public links to ONE invoice PDF for ONE address, usable without an account.
 *
 * The token is 32 random bytes; only its SHA-256 is stored (a copy of the
 * collection cannot be turned into links), and neither the token nor the
 * address is ever persisted or logged. The tenant of a link is the
 * `copropiedadId` of its row: there is no CLS and no `TenantContextService`
 * here, every query carries that id explicitly.
 */
@Injectable()
export class EnlaceFacturaService {
  constructor(
    @InjectModel(EnlaceFactura.name)
    private readonly enlaces: Model<EnlaceFacturaDocument>,
  ) {}

  /**
   * Mints a link for one (invoice, address) pair. One new token per send
   * attempt, so the e-mail that carries it is the only copy. Throws on a
   * storage failure: the caller (the processor) decides what that means.
   */
  async emitir(datos: {
    copropiedadId: Types.ObjectId;
    facturaId: Types.ObjectId;
    envioFacturaId: Types.ObjectId;
    clave: string;
    rol: RolEnlaceFactura;
  }): Promise<EnlaceEmitido> {
    const token = randomBytes(32).toString('hex');
    const expiraEn = new Date(Date.now() + VIGENCIA_ENLACE_FACTURA_MS);
    const fila = await this.enlaces.create({
      tokenHash: hashDe(token),
      copropiedadId: datos.copropiedadId,
      facturaId: datos.facturaId,
      envioFacturaId: datos.envioFacturaId,
      clave: datos.clave,
      rol: datos.rol,
      expiraEn,
      usos: 0,
      revocadoEn: null,
    });
    return { id: String(fila._id), token, expiraEn };
  }

  /** Revokes one link of the coproperty; a second call keeps the first date. */
  async revocarPorId(
    copropiedadId: Types.ObjectId,
    enlaceId: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(enlaceId)) return;
    await this.enlaces
      .updateOne(
        { _id: new Types.ObjectId(enlaceId), copropiedadId, revocadoEn: null },
        { $set: { revocadoEn: new Date(Date.now()) } },
      )
      .exec();
  }

  /** Revokes every open link of an invoice. */
  async revocarPorFactura(
    copropiedadId: Types.ObjectId,
    facturaId: Types.ObjectId,
  ): Promise<void> {
    await this.enlaces
      .updateMany(
        { copropiedadId, facturaId, revocadoEn: null },
        { $set: { revocadoEn: new Date(Date.now()) } },
      )
      .exec();
  }

  /** Revokes every open link addressed to one address (by its `clave`). */
  async revocarPorClave(
    copropiedadId: Types.ObjectId,
    clave: string,
  ): Promise<void> {
    await this.enlaces
      .updateMany(
        { copropiedadId, clave, revocadoEn: null },
        { $set: { revocadoEn: new Date(Date.now()) } },
      )
      .exec();
  }
}
