// src/database/schemas/facturacion/enlace-factura.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { RETENCION_TRAS_VENCER_S } from '../../../modules/factura-publica/factura-publica.constantes';

export type EnlaceFacturaDocument = HydratedDocument<EnlaceFactura> & {
  createdAt: Date;
};

/** Which side of the unit the address belongs to. Same words as `RolDestino`. */
export const ROLES_ENLACE_FACTURA = ['propietario', 'arrendatario'] as const;
export type RolEnlaceFactura = (typeof ROLES_ENLACE_FACTURA)[number];

/**
 * Server-side record behind the public link of ONE (invoice, address) pair,
 * and only one row per pair (unique index below): a new send rotates the
 * token of that row.
 * The link carries a random 32-byte token; only its SHA-256 is stored, so a copy
 * of this collection cannot be turned into links. The row holds ids and
 * hashes only, never the token or the address: `clave` is the hash of the
 * normalized address (pseudonymization, not anonymity).
 *
 * Tenant-owned, but read by a public route that has no tenant context: the
 * `copropiedadId` stored HERE is the tenant of the whole request.
 *
 * Not a financial document, so purging it does not touch the audit law. The
 * TTL keeps each row 90 days AFTER it expires, as an evidence window for the
 * usage counters; validity never relies on the TTL (every read checks
 * `expiraEn`).
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'enlaces_factura',
  versionKey: false,
})
export class EnlaceFactura {
  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Factura', required: true })
  facturaId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'EnvioFactura', required: true })
  envioFacturaId: Types.ObjectId;

  /** `claveCorreo(address)`: the only identity of the address stored here. */
  @Prop({ required: true })
  clave: string;

  @Prop({ type: String, enum: ROLES_ENLACE_FACTURA, required: true })
  rol: RolEnlaceFactura;

  @Prop({ type: Date, required: true })
  expiraEn: Date;

  /** Set by a revocation; the first value is kept. */
  @Prop({ type: Date, default: null })
  revocadoEn: Date | null;

  /** Times the PDF was served. A link scanner counts as a use: this is NOT
   *  proof that a person opened the link. */
  @Prop({ type: Number, default: 0 })
  usos: number;

  @Prop({ type: Date })
  primerUsoEn?: Date;

  @Prop({ type: Date })
  ultimoUsoEn?: Date;
}

export const EnlaceFacturaSchema = SchemaFactory.createForClass(EnlaceFactura);

// ONE link per (invoice, address): `emitir` upserts on this key and rotates
// the token, so only the latest e-mail's link works. Also serves revocation per
// invoice and the view package 4 will build. Unique from the collection's
// first deploy, so no existing data can conflict.
EnlaceFacturaSchema.index(
  { copropiedadId: 1, facturaId: 1, clave: 1 },
  { unique: true },
);
// Bounded growth, with a window to read `usos` after the link expired.
EnlaceFacturaSchema.index(
  { expiraEn: 1 },
  { expireAfterSeconds: RETENCION_TRAS_VENCER_S },
);
