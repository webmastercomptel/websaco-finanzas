// src/database/schemas/administracion/bloque-facturacion.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BloqueFacturacionDocument = HydratedDocument<BloqueFacturacion> & {
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Persisted values equal the API contract values; runtime arrays so the DTOs
 * validate against the same list the schema enforces.
 *
 * `recibo` exists because the system this was ported from accepted it, but it is
 * STAFF-ONLY: residents are never offered a receipt (see
 * `facturacion-bloque-acceso.ts`), so a `recibo` batch can be stored and
 * reviewed but never sent.
 */
export const TIPOS_BLOQUE = ['factura', 'estado_cuenta', 'recibo'] as const;
export type TipoBloque = (typeof TIPOS_BLOQUE)[number];

/**
 * Lifecycle of a block of externally produced billing documents.
 *
 * - `pendiente`: declared, waiting for the browser's upload and for `confirmar`.
 * - `procesando`: one request holds the ingest lease (detecting units, splitting
 *   the PDF). A request that died leaves the lease to expire; confirming again
 *   then restarts the whole ingest from scratch.
 * - `generado`: ingest finished. The per-unit PDFs exist and NOTHING was sent;
 *   the admin reviews the match report and decides. Sendable.
 * - `pendiente_envio`: the explicit send was requested and some delivery is
 *   still outstanding (a request is delivering right now, or it died or hit a
 *   mail outage). Sending again resumes, never repeats.
 * - `enviado`: every resident of every unit was notified. Terminal.
 * - `error`: the PDF could not be read or matched to any unit. Confirming again
 *   retries (typically after fixing the upload); nothing was split.
 *
 * Translation of the previous system's `status`/`sendPending` pair:
 * `pending` -> `pendiente`, `ready` + `sendPending: true` -> `generado`,
 * `ready` + not held -> `enviado`, `error` -> `error`.
 */
export const ESTADOS_BLOQUE = [
  'pendiente',
  'procesando',
  'generado',
  'pendiente_envio',
  'enviado',
  'error',
] as const;
export type EstadoBloque = (typeof ESTADOS_BLOQUE)[number];

/** A unit code found in the PDF that matches no unit of the coproperty. */
@Schema({ _id: false })
export class UnidadNoRegistrada {
  /** Normalized code as read from the PDF (never personal data). */
  @Prop({ required: true })
  codigo: string;

  /** 1-indexed pages of the original that carry it. */
  @Prop({ type: [Number], default: [] })
  paginas: number[];
}

/**
 * One uploaded PDF holding every unit's billing document ("facturación por
 * bloque"). Tenant-owned: every query carries `copropiedadId`.
 *
 * TRANSITIONAL: it exists only to carry PDFs produced outside this system until
 * the native invoice pipeline replaces it. Its per-unit output lives in
 * `DocumentoBloque`; the original stays in Storage as the source of truth.
 */
@Schema({
  timestamps: true,
  collection: 'adm_facturacion_bloques',
  versionKey: false,
})
export class BloqueFacturacion {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: TIPOS_BLOQUE })
  tipo: TipoBloque;

  /** Free label chosen by the admin, e.g. "2026-07". */
  @Prop({ required: true })
  periodo: string;

  /** File name the admin gave the upload. */
  @Prop({ required: true })
  nombre: string;

  /** Storage path of the original PDF. */
  @Prop({ type: String, required: true })
  rutaOriginal: string;

  /** Declared size at first, the real object size once confirmed. */
  @Prop({ required: true, default: 0 })
  tamanoBytes: number;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_BLOQUE,
    default: 'pendiente',
  })
  estado: EstadoBloque;

  @Prop({ required: true, default: 0 })
  totalPaginas: number;

  /** How many per-unit documents the ingest produced. */
  @Prop({ required: true, default: 0 })
  totalUnidades: number;

  /** 1-indexed pages where no unit was recognised (the admin reviews them). */
  @Prop({ type: [Number], default: [] })
  paginasSinMatch: number[];

  /**
   * Codes found in the PDF that match no unit of the coproperty. They are
   * REPORTED and never sent: there is no one to address them to. A typical cause
   * is a code format that differs from `Inmueble.codigo`.
   */
  @Prop({ type: [UnidadNoRegistrada], default: [] })
  unidadesNoRegistradas: UnidadNoRegistrada[];

  /**
   * Units with no resident to reach at the last send (no owner/tenant with an
   * account that may see this kind). Absent = no send ran yet; `[]` = all
   * reached.
   */
  @Prop({ type: [String], default: undefined })
  unidadesSinDestinatario?: string[];

  /** Why the last ingest failed; `null` otherwise. */
  @Prop({ type: String, default: null })
  motivoError: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Account', default: null })
  subidoPorId: Types.ObjectId | null;

  /** Name of the uploader, frozen at upload; never client input. */
  @Prop({ default: '' })
  subidoPorNombre: string;

  /** Account that pressed "send" (first time), frozen; never client input. */
  @Prop({ type: Types.ObjectId, ref: 'Account', default: null })
  enviadoPorId: Types.ObjectId | null;

  @Prop({ default: '' })
  enviadoPorNombre: string;

  /** When the explicit send was first requested; `null` while nothing left. */
  @Prop({ type: Date, default: null })
  enviadoEn: Date | null;

  /** Resident/unit deliveries targeted at the last send run. */
  @Prop({ default: 0 })
  destinatariosTotal: number;

  /** Whether the environment could send email at the last run; `null` before any. */
  @Prop({ type: Boolean, default: null })
  correoConfigurado: boolean | null;

  /** Identifies the request that owns the ingest lease. */
  @Prop({ type: String, default: null })
  tokenProcesamiento: string | null;

  /** Start of the ingest lease; it expires when this gets old. */
  @Prop({ type: Date, default: null })
  procesamientoIniciadoEn: Date | null;

  /** Identifies the request that owns the delivery lease. */
  @Prop({ type: String, default: null })
  tokenEnvio: string | null;

  /** Last heartbeat of the delivery lease holder. */
  @Prop({ type: Date, default: null })
  envioIniciadoEn: Date | null;
}

export const BloqueFacturacionSchema =
  SchemaFactory.createForClass(BloqueFacturacion);
BloqueFacturacionSchema.index({ copropiedadId: 1, createdAt: -1 });
BloqueFacturacionSchema.index({ copropiedadId: 1, tipo: 1, periodo: 1 });
