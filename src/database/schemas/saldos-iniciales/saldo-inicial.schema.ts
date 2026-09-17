import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { Account } from '../cuentas/account.schema';
import { LoteSaldoInicial } from './lote-saldo-inicial.schema';

export type SaldoInicialDocument = HydratedDocument<SaldoInicial>;

export const VOID_REASONS_SALDO_INICIAL = [
  'error_digitacion',
  'duplicado',
  'otro',
] as const;
export type VoidReasonSaldoInicial =
  (typeof VOID_REASONS_SALDO_INICIAL)[number];

/**
 * One línea of a Saldo Inicial's own charge breakdown — the minimum
 * `FacturaLinea` needs for cartera purposes (no tax: an opening balance
 * brought from another system is already a net figure). Frozen at import
 * time, same reasoning as `FacturaLinea` itself: a later rename of the
 * concepto, or a later edit of its accounting account, must never alter what
 * was already imported.
 */
@Schema({ _id: false })
export class SaldoInicialLinea {
  @Prop({ type: SchemaTypes.ObjectId, ref: ConceptoCobro.name, required: true })
  conceptoId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  conceptName: string;

  /** This concept's DEBIT account, frozen the same way `FacturaLinea`'s own
   *  `accountingReceivableAccount` is — null falls back to the coproperty's
   *  shared `receivablesAccount` at posting time, the same way a Factura
   *  line does (see `construirMovimientos`, asiento.builder.ts). Only ever
   *  read once a real Recibo/Nota Crédito collects part of this balance —
   *  the import itself never posts to accounting. */
  @Prop({ type: String, default: null, trim: true })
  accountingReceivableAccount: string | null;

  /** This concept's CREDIT/income account, frozen the same way. Unlike a
   *  Factura, nothing here was ever posted as income IN THIS SYSTEM (the
   *  import never touches `AsientoContable` — see this document's own
   *  docblock), so a later Nota Crédito writing off part of this balance has
   *  no real income to reverse: `null` here deliberately falls through to
   *  `postearAsientoCreacion`'s existing `cuentaDevoluciones` fallback,
   *  same as any Factura/Nota Débito line with no income account
   *  configured — never a dedicated "reverse income" debit. */
  @Prop({ type: String, default: null, trim: true })
  accountingIncomeAccount: string | null;

  /** `ConceptoCobro.kind` at import time — only inspected for `'intereses'`
   *  (`NotasCreditoService.crear()`'s own mora-tracking), same reasoning as
   *  `FacturaLinea.conceptKind`. */
  @Prop({
    required: true,
    enum: ['administracion', 'intereses', 'otro'],
    default: 'otro',
  })
  conceptKind: 'administracion' | 'intereses' | 'otro';

  @Prop({ required: true })
  montoOriginal: number;
}

export const SaldoInicialLineaSchema =
  SchemaFactory.createForClass(SaldoInicialLinea);

/**
 * A THIRD cartera charge document, alongside Factura (`FV`) and Nota Débito
 * (`ND`) — see `DOCUMENT_TYPES` (`aplicacion-cartera.schema.ts`), whose
 * `'SI'` value this document plugs into so it is aged in every cartera
 * report and collectible by a future Recibo/Nota Crédito, exactly like a
 * Factura, WITHOUT consuming Factura/NotaDebito's own numbering or polluting
 * their already-audited listings.
 *
 * `tipoDocumentoOriginal`/`numeroOriginal` are free text the client brings
 * from their previous system — informational only, never validated against
 * `DOCUMENT_TYPES` and never a real consecutivo (see `LoteSaldoInicial`'s own
 * docblock). The import never posts to `AsientoContable` — this collection,
 * plus the shared `SaldoTotalDocumento`/`CarteraPorDocumento`/`SaldoCartera`
 * rows it seeds, is purely cartera (subledger); accounting only enters the
 * picture later, when a real Recibo/Nota Crédito collects part of this debt.
 */
@Schema({ timestamps: true, collection: 'saldos_iniciales' })
export class SaldoInicial {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: LoteSaldoInicial.name,
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

  /** Frozen — same reasoning as `Factura.unitCode`: a unit's code changing
   *  later must not alter what was already imported. */
  @Prop({ required: true, trim: true })
  unitCode: string;

  /** Internal ordinal (`ConsecutivoSaldoInicial`) — NEVER a real DIAN
   *  consecutivo, see that schema's own docblock. Only exists so this
   *  document has a bare `number` to print/redact wherever a Factura/Nota
   *  Débito's own `number` already shows. */
  @Prop({ required: true })
  number: number;

  @Prop({ required: true, trim: true, maxlength: 20 })
  tipoDocumentoOriginal: string;

  @Prop({ required: true, trim: true, maxlength: 40 })
  numeroOriginal: string;

  @Prop({ required: true })
  fecha: Date;

  @Prop({ required: true })
  fechaVencimiento: Date;

  @Prop({ type: [SaldoInicialLineaSchema], required: true, default: [] })
  lines: SaldoInicialLinea[];

  @Prop({ required: true })
  total: number;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  status: 'activo' | 'anulado';

  @Prop({ type: String, enum: VOID_REASONS_SALDO_INICIAL, default: null })
  voidedReason: VoidReasonSaldoInicial | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, default: null })
  voidedBy: Types.ObjectId | null;
}

export const SaldoInicialSchema = SchemaFactory.createForClass(SaldoInicial);

// Re-importing the same file twice must not duplicate the same row — the
// client's own (tipo, número) pair, per unit, is what they'd recognize as
// "the same document" if they upload it again.
SaldoInicialSchema.index(
  {
    coPropertyId: 1,
    inmuebleId: 1,
    tipoDocumentoOriginal: 1,
    numeroOriginal: 1,
  },
  { unique: true },
);
