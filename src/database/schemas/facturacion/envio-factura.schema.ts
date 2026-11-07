// src/database/schemas/facturacion/envio-factura.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type EnvioFacturaDocument = HydratedDocument<EnvioFactura> & {
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Send pipeline of ONE native invoice: `generado -> pendiente_envio -> enviado`
 * (+ `error`). `generado` has no row: it is simply an invoice nobody has marked,
 * so the invoice document itself is never touched by the pipeline.
 */
export const ESTADOS_ENVIO_FACTURA = [
  'pendiente_envio',
  'enviado',
  'error',
] as const;
export type EstadoEnvioFactura = (typeof ESTADOS_ENVIO_FACTURA)[number];

/** Why a row sits in `error`. Closed set: the staff screen explains each one. */
export const MOTIVOS_ERROR_ENVIO = [
  'sin_destinatarios',
  'factura_anulada',
  'factura_inexistente',
  'reintentos_agotados',
] as const;
export type MotivoErrorEnvio = (typeof MOTIVOS_ERROR_ENVIO)[number];

/**
 * Bookkeeping of sending one invoice to the people who hold its unit. Created
 * ONLY by the explicit "mark for sending" action; nothing in the system creates
 * one on its own. Tenant-owned: every query carries `copropiedadId`.
 *
 * Why a separate collection and not fields on `Factura`: a financial document is
 * frozen by design, and "who released this to the residents and when" is
 * workflow state, not part of the invoice. Nothing financial is read or written
 * here beyond the invoice number it points at.
 *
 * Delivery progress is recorded per (invoice, recipient) with `$addToSet` AFTER
 * each delivery succeeded, so processing the row again only reaches whoever is
 * missing (same design as the block billing and the announcements). The lease
 * (`tokenEnvio` + `envioIniciadoEn`, renewed after every batch) keeps two
 * concurrent processors from delivering the same row.
 *
 * `liberadaEn` is set at the FIRST claim and is what makes the invoice visible
 * in the resident portal: staff reviewed it and pressed send, so residents may
 * open it even while some of the notices are still being retried.
 */
@Schema({ timestamps: true, collection: 'envios_factura', versionKey: false })
export class EnvioFactura {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Factura', required: true })
  facturaId: Types.ObjectId;

  /** The unit the invoice belongs to: the ONLY thing recipients are matched on. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Inmueble', required: true })
  inmuebleId: Types.ObjectId;

  /** `Inmueble.codigo` as stored on the invoice, for display. */
  @Prop({ required: true, trim: true })
  codigoInmueble: string;

  /** Frozen copy of `Factura.numeroCompleto`, so the queue reads without a join. */
  @Prop({ required: true, trim: true })
  numeroCompleto: string;

  /** The billing run the invoice came from, when it has one (filter in the queue). */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'LoteFacturacion', default: null })
  loteId: Types.ObjectId | null;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_ENVIO_FACTURA,
    default: 'pendiente_envio',
  })
  estado: EstadoEnvioFactura;

  /** Who pressed "mark for sending" (the last time it was marked) and when. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Account', required: true })
  marcadoPorId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  marcadoPorNombre: string;

  @Prop({ type: Date, required: true })
  marcadoEn: Date;

  /**
   * First time a processor claimed the row; no default on purpose, so a `$min`
   * can set it only once. Absent = never released = invisible to residents.
   */
  @Prop({ type: Date })
  liberadaEn?: Date;

  /** Who ran the processor that claimed the row last. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Account', default: null })
  procesadoPorId: Types.ObjectId | null;

  @Prop({ type: String, default: '' })
  procesadoPorNombre: string;

  /** The run (audit entry id) that claimed the row last. */
  @Prop({ type: SchemaTypes.ObjectId, default: null })
  ultimaCorridaId: Types.ObjectId | null;

  /** When every recipient had been reached. Null until then. */
  @Prop({ type: Date, default: null })
  enviadoEn: Date | null;

  /** How many people the row was addressed to at the last attempt. */
  @Prop({ type: Number, default: 0 })
  destinatariosTotal: number;

  /** Accounts whose in-app notification was already created. */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'Account', default: [] })
  notificadosIds: Types.ObjectId[];

  /** Accounts whose email the provider already accepted. */
  @Prop({ type: [SchemaTypes.ObjectId], ref: 'Account', default: [] })
  correosEnviadosIds: Types.ObjectId[];

  /** Lease: the run holding the row, and the last time it proved it was alive. */
  @Prop({ type: String, default: null })
  tokenEnvio: string | null;

  @Prop({ type: Date, default: null })
  envioIniciadoEn: Date | null;

  /** Failed attempts since the row was last marked. */
  @Prop({ type: Number, default: 0 })
  intentos: number;

  /** Earliest moment the row may be claimed again (backoff after a failure). */
  @Prop({ type: Date, default: null })
  proximoIntentoEn: Date | null;

  @Prop({ type: String, enum: [...MOTIVOS_ERROR_ENVIO, null], default: null })
  ultimoError: MotivoErrorEnvio | null;
}

export const EnvioFacturaSchema = SchemaFactory.createForClass(EnvioFactura);

// One row per invoice: marking twice (or two clicks at once) can never double it.
EnvioFacturaSchema.index(
  { copropiedadId: 1, facturaId: 1 },
  { unique: true, name: 'unico_envio_por_factura' },
);
// The processor's claim and the queue screen: "this coproperty's rows in a state".
EnvioFacturaSchema.index({ copropiedadId: 1, estado: 1, marcadoEn: 1 });
// The portal gate: "which invoices of this unit were released".
EnvioFacturaSchema.index({ copropiedadId: 1, inmuebleId: 1, liberadaEn: 1 });
