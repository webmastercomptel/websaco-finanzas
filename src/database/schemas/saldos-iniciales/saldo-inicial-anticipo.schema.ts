import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
import { Account } from '../cuentas/account.schema';
import { LoteSaldoInicialAnticipo } from './lote-saldo-inicial-anticipo.schema';

export type SaldoInicialAnticipoDocument =
  HydratedDocument<SaldoInicialAnticipo>;

export const VOID_REASONS_SALDO_INICIAL_ANTICIPO = [
  'error_digitacion',
  'duplicado',
  'otro',
] as const;
export type VoidReasonSaldoInicialAnticipo =
  (typeof VOID_REASONS_SALDO_INICIAL_ANTICIPO)[number];

/**
 * An opening ANTICIPO balance brought from a client's previous system — a
 * unit had already paid ahead, and that leftover credit is still theirs to
 * draw down here. Deliberately its own document, never a synthetic `Recibo`:
 * a Recibo means real cash arrived in THIS system on that date, and every
 * report that reads `Recibo` (cartera, auxiliar, conciliación bancaria, the
 * Recibos listing, its own PDF) would show this historical balance as if it
 * had. Same reasoning `SaldoInicial` already applies on the charge side
 * (never a fake Factura) — see that schema's own docblock.
 *
 * Feeds `SaldoDocumentoOrigen` (`tipoDocumento: 'SI'`) exactly like a Recibo
 * feeds its own `'RC'` row, so `NotaAnticipoService` can draw against it
 * through the SAME generic `cruce.util.ts` machinery — see
 * `NotaAnticipo.origenTipo`'s own docblock. `fullNumber`/`receivedDate` are
 * named to match `Recibo`'s own fields on purpose, for that same reason:
 * `cruce.util.ts`'s `OrigenAplicacion` constraint reads them regardless of
 * which collection the document actually came from.
 *
 * `tipoDocumentoOriginal`/`numeroOriginal` are free text the client brings
 * from their previous system (typically `'RC'` and that system's own
 * receipt number) — informational only, same as `SaldoInicial`'s own fields;
 * `fullNumber` is this system's own frozen display string built from them,
 * never a real consecutivo.
 */
@Schema({ timestamps: true, collection: 'saldos_iniciales_anticipo' })
export class SaldoInicialAnticipo {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: LoteSaldoInicialAnticipo.name,
    required: true,
    index: true,
  })
  loteId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  /** Frozen at import time from `Inmueble.holderId` — same reasoning as
   *  `NotaDebito.terceroId`: the party this credit belongs to, fixed at the
   *  moment that matters, never re-derived later. Nullable because a unit's
   *  current titular can itself be unset. */
  @Prop({ type: SchemaTypes.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  /** Frozen — same reasoning as `SaldoInicial.unitCode`. */
  @Prop({ required: true, trim: true })
  unitCode: string;

  /** Internal ordinal (`ConsecutivoSaldoInicialAnticipo`) — never a real
   *  consecutivo, same reasoning as `SaldoInicial.number`. */
  @Prop({ required: true })
  number: number;

  @Prop({ required: true, trim: true, maxlength: 20 })
  tipoDocumentoOriginal: string;

  @Prop({ required: true, trim: true, maxlength: 40 })
  numeroOriginal: string;

  /** This system's own frozen display string (`tipoDocumentoOriginal` +
   *  `numeroOriginal`) — never a real consecutivo, but named `fullNumber` so
   *  it satisfies `cruce.util.ts`'s `OrigenAplicacion` shape the exact same
   *  way `Recibo.fullNumber` does. */
  @Prop({ required: true, trim: true })
  fullNumber: string;

  /** When this money actually arrived, per the client's previous system —
   *  same semantic as `Recibo.receivedDate`, same field name so this
   *  document satisfies `cruce.util.ts`'s `OrigenAplicacion` shape without
   *  any adapter. Drives pronto-pago discount eligibility exactly like a
   *  real Recibo's own `receivedDate` would (`evaluarAplicacionConDescuento`
   *  reads it regardless of which collection the origin came from). */
  @Prop({ required: true })
  receivedDate: Date;

  @Prop({ required: true })
  montoOriginal: number;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  status: 'activo' | 'anulado';

  @Prop({
    type: String,
    enum: VOID_REASONS_SALDO_INICIAL_ANTICIPO,
    default: null,
  })
  voidedReason: VoidReasonSaldoInicialAnticipo | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, default: null })
  voidedBy: Types.ObjectId | null;
}

export const SaldoInicialAnticipoSchema =
  SchemaFactory.createForClass(SaldoInicialAnticipo);

// Re-importing the same file twice must not duplicate the same row — same
// reasoning and same shape as `SaldoInicialSchema`'s own index.
SaldoInicialAnticipoSchema.index(
  {
    coPropertyId: 1,
    inmuebleId: 1,
    tipoDocumentoOriginal: 1,
    numeroOriginal: 1,
  },
  { unique: true },
);
