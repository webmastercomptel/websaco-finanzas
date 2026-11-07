// src/database/schemas/administracion/anuncio.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AnuncioDocument = HydratedDocument<Anuncio>;

/**
 * Persisted values equal the API contract values; runtime arrays so the DTOs
 * validate against the same list the schema enforces.
 */
export const CATEGORIAS_ANUNCIO = [
  'mantenimiento',
  'seguridad',
  'comunidad',
  'administracion',
] as const;
export type CategoriaAnuncio = (typeof CATEGORIAS_ANUNCIO)[number];

/**
 * Lifecycle of an announcement.
 *
 * - `borrador`: written, invisible to residents, nothing sent.
 * - `enviando`: a publish request holds the delivery lease (or died holding it;
 *   the lease expires and publishing again resumes).
 * - `enviado`: every resident was notified in-app AND emailed. Terminal.
 * - `fallido`: published (visible), but at least one delivery is still pending
 *   (mail outage, mail not configured). Publishing again completes the rest.
 */
export const ESTADOS_ANUNCIO = [
  'borrador',
  'enviando',
  'enviado',
  'fallido',
] as const;
export type EstadoAnuncio = (typeof ESTADOS_ANUNCIO)[number];

/** Email is the only delivery channel that was ever wired up. */
export const CANALES_ANUNCIO = ['email'] as const;
export type CanalAnuncio = (typeof CANALES_ANUNCIO)[number];

/**
 * A building-wide announcement of one coproperty. Tenant-owned: every query
 * carries `copropiedadId`.
 *
 * Nothing here is a counter that mirrors another structure: the number of likes
 * IS `meGustaIds.length`, and the delivery progress IS the two id arrays below,
 * so none of them can drift out of sync with a separate total. Every mutation of
 * those arrays goes through `$addToSet`/`$pull` (never read-modify-save).
 *
 * `vistas` is the one plain counter: it counts opens, not people, and nothing
 * else records the same fact.
 */
@Schema({
  timestamps: true,
  collection: 'adm_anuncios',
  versionKey: false,
})
export class Anuncio {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true })
  titulo: string;

  @Prop({ default: '' })
  contenido: string;

  @Prop({
    type: String,
    required: true,
    enum: CATEGORIAS_ANUNCIO,
    default: 'comunidad',
  })
  categoria: CategoriaAnuncio;

  /** Name of the account that created it, frozen at creation; never client input. */
  @Prop({ default: '' })
  autor: string;

  @Prop({ type: String, default: null })
  imagenUrl: string | null;

  @Prop({ default: false })
  destacado: boolean;

  @Prop({ required: true, default: 0 })
  vistas: number;

  /** Accounts that liked it. Mutated only through atomic operators. */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  meGustaIds: Types.ObjectId[];

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_ANUNCIO,
    default: 'borrador',
  })
  estado: EstadoAnuncio;

  /** When it was first published; `null` while it is a draft. */
  @Prop({ type: Date, default: null })
  publicadoEn: Date | null;

  /** Accounts whose in-app notification was already created (delivery progress). */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  notificadosIds: Types.ObjectId[];

  /** Accounts whose email the provider already accepted (delivery progress). */
  @Prop({ type: [Types.ObjectId], ref: 'Account', default: [] })
  correosEnviadosIds: Types.ObjectId[];

  /** Audience size at the last delivery run. */
  @Prop({ default: 0 })
  destinatariosTotal: number;

  /** Whether the environment could send email at the last run; `null` before any run. */
  @Prop({ type: Boolean, default: null })
  correoConfigurado: boolean | null;

  /** Identifies the publish request that owns the delivery lease. */
  @Prop({ type: String, default: null })
  tokenEnvio: string | null;

  /** Last heartbeat of the lease holder; the lease expires when this gets old. */
  @Prop({ type: Date, default: null })
  envioIniciadoEn: Date | null;
}

export const AnuncioSchema = SchemaFactory.createForClass(Anuncio);
AnuncioSchema.index({ copropiedadId: 1, estado: 1, publicadoEn: -1 });
AnuncioSchema.index({ copropiedadId: 1, createdAt: -1 });
AnuncioSchema.index({ copropiedadId: 1, categoria: 1 });
