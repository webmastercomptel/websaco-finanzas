// src/database/schemas/administracion/reserva.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ReservaDocument = HydratedDocument<Reserva>;

/**
 * Persisted values are the Spanish ones the API speaks. The system this was
 * ported from stored `pending` / `approved` / `rejected` / `cancelled`.
 *
 * `cancelada` is also what the hourly sweep sets on a request nobody answered
 * before it started.
 */
export const ESTADOS_RESERVA = [
  'pendiente',
  'aprobada',
  'rechazada',
  'cancelada',
] as const;
export type EstadoReserva = (typeof ESTADOS_RESERVA)[number];

/** The states in which a booking occupies its time slot. */
export const ESTADOS_RESERVA_ACTIVOS = ['pendiente', 'aprobada'] as const;

/** Whether a state keeps the slot reserved (drives `activa`). */
export const ocupaFranja = (estado: EstadoReserva): boolean =>
  (ESTADOS_RESERVA_ACTIVOS as readonly string[]).includes(estado);

/**
 * A booking of a common area. Tenant-owned: every query carries
 * `copropiedadId`. There is no business code: the system this was ported from
 * had none either.
 *
 * `autorId` is the resident account that requested it through the portal; it is
 * null when staff registered it on somebody's behalf, and it is what scopes a
 * resident to "my reservations". `residente` and `unidad` are text snapshots,
 * frozen so the history reads the same after a rename or a change of owner.
 *
 * Two derived fields exist ONLY to make double booking impossible (the system
 * this replaces checked for overlaps with a read and then wrote, so two requests
 * for the same slot both went through):
 *
 * - `franjas`: every UTC minute `[inicio, fin)` covers (see `franjasDe`).
 * - `activa`: whether the booking still occupies those minutes (`pendiente` or
 *   `aprobada`).
 *
 * A partial UNIQUE multikey index on `(zonaId, franjas)` where `activa` is true
 * lets Mongo itself reject the second of two overlapping active bookings, even
 * when the two requests land on different instances. `activa` must therefore be
 * written in the same atomic update as `estado`. Neither is ever exposed.
 */
@Schema({ timestamps: true, collection: 'adm_reservas', versionKey: false })
export class Reserva {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Zona', required: true })
  zonaId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Account', default: null })
  autorId: Types.ObjectId | null;

  /** Name of who the booking is for, frozen as text. */
  @Prop({ default: '' })
  residente: string;

  /** Unit code as typed in the unit register (`A-101`), not a reference. */
  @Prop({ default: '' })
  unidad: string;

  @Prop({ required: true })
  inicio: Date;

  @Prop({ required: true })
  fin: Date;

  @Prop({ type: String, default: null })
  motivo: string | null;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_RESERVA,
    default: 'pendiente',
  })
  estado: EstadoReserva;

  /** `estado` is `pendiente` or `aprobada`. Written together with `estado`, always. */
  @Prop({ required: true, default: true })
  activa: boolean;

  /** Minute slots covered; `select: false` because it can hold up to 1440 numbers. */
  @Prop({ type: [Number], default: [], select: false })
  franjas: number[];
}

export const ReservaSchema = SchemaFactory.createForClass(Reserva);
// The double-booking guard (see the class docblock).
ReservaSchema.index(
  { zonaId: 1, franjas: 1 },
  { unique: true, partialFilterExpression: { activa: true } },
);
// "My reservations" of a resident, and the one-active-booking-per-area rule.
ReservaSchema.index({ copropiedadId: 1, autorId: 1, inicio: -1 });
// Overlap pre-check and availability of one area.
ReservaSchema.index({ zonaId: 1, inicio: 1, fin: 1 });
ReservaSchema.index({ copropiedadId: 1, estado: 1, inicio: 1 });
// The hourly sweep: pending requests already started, across coproperties.
ReservaSchema.index({ estado: 1, inicio: 1 });
