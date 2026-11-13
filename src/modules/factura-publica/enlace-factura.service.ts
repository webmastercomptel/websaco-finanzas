// src/modules/factura-publica/enlace-factura.service.ts
import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { destinosDeUnidad } from '../../common/directorio/destinos-correo';
import { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import { modulosEfectivos } from '../../common/licencia/modulos';
import { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Inmueble,
  type InmuebleDocument,
} from '../../database/schemas/copropiedades/inmueble.schema';
import {
  EnlaceFactura,
  type EnlaceFacturaDocument,
  type RolEnlaceFactura,
} from '../../database/schemas/facturacion/enlace-factura.schema';
import {
  EnvioFactura,
  type EnvioFacturaDocument,
} from '../../database/schemas/facturacion/envio-factura.schema';
import {
  Factura,
  type FacturaDocument,
} from '../../database/schemas/facturacion/factura.schema';
import {
  Tercero,
  type TerceroDocument,
} from '../../database/schemas/terceros/tercero.schema';
import { paginaIndividualDeFactura } from '../facturacion/factura-pdf.util';
import {
  decisionAnulada,
  FORMATO_TOKEN,
  VIGENCIA_ENLACE_FACTURA_MS,
} from './factura-publica.constantes';

const hashDe = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** What `emitir` hands to the processor. `token` exists only here and in the
 *  e-mail it is about to travel in; it is never persisted. */
export interface EnlaceEmitido {
  id: string;
  token: string;
  expiraEn: Date;
}

/** A link that passed every check, with the bytes of its invoice's page. */
export interface EnlaceResuelto {
  bytes: Uint8Array;
  numeroCompleto: string;
  enlaceId: string;
  envioFacturaId: string;
}

/**
 * The fixed facts of the link's invoice, shown above the PDF buttons. Only
 * what is already printed on the PDF; deliberately NOT the live balance (it
 * changes with every payment and is debt information the portal guards).
 */
export interface ResumenFacturaPublica {
  numeroCompleto: string;
  codigoInmueble: string;
  periodoDesde: string;
  periodoHasta: string;
  fechaVencimiento: string;
  total: number;
  anulada: boolean;
}

/**
 * Public links to ONE invoice PDF for ONE address, usable without an account.
 *
 * Security contract (the route behind it is public):
 * - The token is 32 random bytes; only its SHA-256 is stored. Lookup is "hash,
 *   then exact match on the unique index": the attacker controls the token,
 *   not the hash, so there is no stored secret to compare in constant time.
 * - The tenant is the `copropiedadId` of the link row. There is no CLS, no
 *   `TenantContextService` and no `FacturasService.findOneRaw` here: every
 *   query carries that id explicitly.
 * - `resolver` answers `null` for EVERY cause (malformed, unknown, expired,
 *   revoked, licence, voided, unreleased, address no longer a recipient, no PDF,
 *   any exception). It never throws and never forwards an internal message,
 *   which can carry an invoice id. The reason goes to the log with the link id
 *   when known; never the token, its hash or an address.
 * - Editing the records IS a revocation: the address must still be one of the
 *   unit's recipients NOW, computed with the same pure function the sender uses.
 */
@Injectable()
export class EnlaceFacturaService {
  private readonly logger = new Logger(EnlaceFacturaService.name);

  constructor(
    @InjectModel(EnlaceFactura.name)
    private readonly enlaces: Model<EnlaceFacturaDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Factura.name)
    private readonly facturas: Model<FacturaDocument>,
    @InjectModel(EnvioFactura.name)
    private readonly envios: Model<EnvioFacturaDocument>,
    @InjectModel(Inmueble.name)
    private readonly inmuebles: Model<InmuebleDocument>,
    @InjectModel(Tercero.name)
    private readonly terceros: Model<TerceroDocument>,
    private readonly presentacionDocumento: PresentacionDocumentoService,
    private readonly storage: DocumentoStorageService,
  ) {}

  /**
   * Mints the link of one (invoice, address) pair. One new token per send
   * attempt, so the e-mail that carries it is the only copy, and ONE row per
   * pair: a single atomic upsert on the unique `{copropiedadId, facturaId,
   * clave}` rotates the stored hash, resets the expiry and clears any
   * revocation, so the link of an earlier e-mail to that address stops working
   * and only the latest one does (a retry after a failed delivery record, or
   * two overlapping processors, cannot leave two valid links). The usage
   * counters are kept across rotations. Two concurrent first upserts cannot
   * both insert: the filter is an equality match on exactly the unique key,
   * which MongoDB (4.2+) retries as an update on a duplicate-key race. Throws
   * on a storage failure: the caller (the processor) decides what that means.
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
    const fila = await this.enlaces
      .findOneAndUpdate(
        {
          copropiedadId: datos.copropiedadId,
          facturaId: datos.facturaId,
          clave: datos.clave,
        },
        {
          $set: {
            tokenHash: hashDe(token),
            envioFacturaId: datos.envioFacturaId,
            rol: datos.rol,
            expiraEn,
            revocadoEn: null,
          },
          $setOnInsert: { usos: 0 },
        },
        { upsert: true, new: true, projection: { _id: 1 } },
      )
      .lean()
      .exec();
    // An upsert returning the new document always yields one; typed as nullable.
    if (!fila) throw new Error('El enlace de la factura no quedó guardado');
    return { id: String(fila._id), token, expiraEn };
  }

  /**
   * Turns a token into the bytes of its invoice's page, or `null` (see the
   * class docblock). The usage counters are written only after the bytes were
   * built, so a refusal never writes.
   */
  async resolver(token: string): Promise<EnlaceResuelto | null> {
    const validado = await this.validar(token);
    if (!validado) return null;
    const { enlace, factura, enlaceId } = validado;
    try {
      const bytes = await paginaIndividualDeFactura(
        String(enlace.facturaId),
        factura,
        this.presentacionDocumento,
        this.storage,
      );

      await this.registrarUso(enlaceId, enlace._id);
      return {
        bytes,
        numeroCompleto: factura.numeroCompleto,
        enlaceId,
        envioFacturaId: String(enlace.envioFacturaId),
      };
    } catch (error: unknown) {
      const clase = error instanceof Error ? error.name : 'desconocido';
      return this.rechazar(`excepción (${clase})`, enlaceId);
    }
  }

  /**
   * The summary of the link's invoice, under EXACTLY the same checks as the
   * PDF (same refusals, same `null`). Writes no usage: only the PDF counts as
   * an opening.
   */
  async resumen(token: string): Promise<ResumenFacturaPublica | null> {
    const validado = await this.validar(token);
    if (!validado) return null;
    const { factura } = validado;
    return {
      numeroCompleto: factura.numeroCompleto,
      codigoInmueble: factura.codigoInmueble,
      periodoDesde: new Date(factura.periodoDesde).toISOString(),
      periodoHasta: new Date(factura.periodoHasta).toISOString(),
      fechaVencimiento: new Date(factura.fechaVencimiento).toISOString(),
      total: factura.total,
      anulada: factura.estado !== 'emitida',
    };
  }

  /**
   * The address of a still-valid link (same checks as the PDF), so the public
   * page can ask for a portal sign-in link for it. Only ever handed to
   * `IngresoPortalService.solicitar`, which e-mails THAT address: the holder of
   * the invoice link never sees it and gains nothing unless they read that
   * inbox. Never returned to the client, never logged.
   */
  async correoDelEnlace(token: string): Promise<string | null> {
    const validado = await this.validar(token);
    return validado ? validado.correo : null;
  }

  /** Every refusal of a link, shared by the PDF, the summary and the sign-in. */
  private async validar(token: string) {
    let enlaceId: string | undefined;
    try {
      if (typeof token !== 'string' || !FORMATO_TOKEN.test(token)) {
        return this.rechazar('formato inválido');
      }
      const enlace = await this.enlaces
        .findOne({ tokenHash: hashDe(token) })
        .lean()
        .exec();
      if (!enlace) return this.rechazar('desconocido');
      enlaceId = String(enlace._id);

      if (enlace.expiraEn.getTime() <= Date.now()) {
        return this.rechazar('vencido', enlaceId);
      }
      if (enlace.revocadoEn) return this.rechazar('revocado', enlaceId);

      const { copropiedadId } = enlace;
      const copropiedad = await this.copropiedades
        .findById(copropiedadId)
        .select('estado modulosContratados')
        .lean()
        .exec();
      if (
        !copropiedad ||
        copropiedad.estado !== 'active' ||
        !modulosEfectivos(copropiedad).includes('finanzas')
      ) {
        return this.rechazar('copropiedad sin licencia', enlaceId);
      }

      const factura = await this.facturas
        .findOne({ _id: enlace.facturaId, copropiedadId })
        .select(
          'estado inmuebleId loteId numeroCompleto printSnapshot paginaEnLote codigoInmueble periodoDesde periodoHasta fechaVencimiento total',
        )
        .lean()
        .exec();
      if (!factura) return this.rechazar('factura ausente', enlaceId);
      if (factura.estado !== 'emitida' && decisionAnulada() === 'rechazar') {
        return this.rechazar('factura anulada', enlaceId);
      }

      const liberada = await this.envios
        .exists({
          copropiedadId,
          facturaId: enlace.facturaId,
          liberadaEn: { $ne: null },
        })
        .exec();
      if (!liberada) return this.rechazar('factura sin liberar', enlaceId);

      const destino = await this.destinoActual(
        copropiedadId,
        factura.inmuebleId,
        enlace.clave,
      );
      if (!destino) {
        return this.rechazar('la dirección ya no es destinataria', enlaceId);
      }

      return { enlace, factura, enlaceId, correo: destino.email };
    } catch (error: unknown) {
      // Only the error CLASS is logged: its message can carry an invoice id or
      // a storage path.
      const clase = error instanceof Error ? error.name : 'desconocido';
      return this.rechazar(`excepción (${clase})`, enlaceId);
    }
  }

  /**
   * Revokes one link of the coproperty; a second call keeps the first date.
   * With `token`, only while the row still holds THAT token: a processor
   * revoking the link of its refused e-mail must not kill the token another
   * attempt has since rotated into the same row.
   */
  async revocarPorId(
    copropiedadId: Types.ObjectId,
    enlaceId: string,
    token?: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(enlaceId)) return;
    await this.enlaces
      .updateOne(
        {
          _id: new Types.ObjectId(enlaceId),
          copropiedadId,
          revocadoEn: null,
          ...(token === undefined ? {} : { tokenHash: hashDe(token) }),
        },
        { $set: { revocadoEn: new Date(Date.now()) } },
      )
      .exec();
  }

  /**
   * Revokes every open link of an invoice. Required by the spec (REQ-L7) for
   * package 4 and the runbook; it has no route and no caller in this change.
   */
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

  /**
   * Flip point for "a link stops working when its address leaves the record":
   * the address must be among the unit's recipients computed NOW from its
   * current titular and arrendatario (active unit, active parties, same
   * coproperty), by the same function the sender uses.
   */
  private async destinoActual(
    copropiedadId: Types.ObjectId,
    inmuebleId: Types.ObjectId,
    clave: string,
  ): Promise<{ email: string } | null> {
    const unidad = await this.inmuebles
      .findOne({ _id: inmuebleId, copropiedadId, estado: 'active' })
      .select('titularId arrendatarioId')
      .lean()
      .exec();
    if (!unidad) return null;
    const ids = [unidad.titularId, unidad.arrendatarioId].filter(
      (id): id is Types.ObjectId => !!id,
    );
    if (ids.length === 0) return null;
    const partes = await this.terceros
      .find({ _id: { $in: ids }, copropiedadId, estado: 'active' })
      .select('nombre emails')
      .lean()
      .exec();
    const porId = new Map(partes.map((t) => [String(t._id), t]));
    const destinos = destinosDeUnidad(
      unidad.titularId ? porId.get(String(unidad.titularId)) : null,
      unidad.arrendatarioId ? porId.get(String(unidad.arrendatarioId)) : null,
    );
    return destinos.find((d) => d.clave === clave) ?? null;
  }

  /** Best effort: a failed write is logged with the link id and still serves. */
  private async registrarUso(
    enlaceId: string,
    _id: Types.ObjectId,
  ): Promise<void> {
    try {
      const ahora = new Date(Date.now());
      await this.enlaces
        .updateOne(
          { _id },
          {
            $inc: { usos: 1 },
            $min: { primerUsoEn: ahora },
            $set: { ultimoUsoEn: ahora },
          },
        )
        .exec();
    } catch {
      this.logger.error(`No se pudo registrar el uso del enlace ${enlaceId}`);
    }
  }

  private rechazar(motivo: string, enlaceId?: string): null {
    this.logger.warn(
      enlaceId
        ? `enlace ${enlaceId} rechazado: ${motivo}`
        : `enlace rechazado: ${motivo}`,
    );
    return null;
  }
}
