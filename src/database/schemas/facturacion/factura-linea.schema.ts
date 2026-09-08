import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, Types } from 'mongoose';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';

/**
 * A party's identity as it must print on an issued document, frozen at
 * emission time. Never re-read from Tercero afterward — the same reasoning
 * already written into the Tercero schema: correcting a typo today must
 * never change what a document already issued says.
 */
@Schema({ _id: false })
export class TitularCongelado {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null, trim: true })
  identificationType: string | null;

  @Prop({ type: String, default: null, trim: true })
  identificationNumber: string | null;

  @Prop({ type: String, default: null, trim: true })
  identificationVerificationDigit: string | null;

  @Prop({ type: String, default: null, trim: true })
  address: string | null;

  @Prop({ type: String, default: null, trim: true })
  city: string | null;

  @Prop({ type: String, default: null, trim: true })
  email: string | null;
}

export const TitularCongeladoSchema =
  SchemaFactory.createForClass(TitularCongelado);

/**
 * One invoice line. Everything about the concept it charges is frozen at the
 * moment the line is built — see ConceptoCobro's own schema comment for why:
 * "changing it here must never alter what an issued invoice says." The one
 * exception is `novedadId`, which is trace/edit-linking metadata rather than
 * a frozen billing fact — see its own comment below.
 */
@Schema({ _id: false })
export class FacturaLinea {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
  })
  conceptoId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  conceptName: string;

  @Prop({
    required: true,
    enum: ['administracion', 'intereses', 'otro'],
  })
  conceptKind: 'administracion' | 'intereses' | 'otro';

  @Prop({ type: String, default: null, trim: true })
  accountingIncomeAccount: string | null;

  /** This concept's DEBIT account — null falls back to the coproperty's
   *  shared `receivablesAccount` at posting time, the same way
   *  `accountingIncomeAccount` falls back to `CUENTA_SIN_ASIGNAR`. See
   *  `construirMovimientos` (asiento.builder.ts). */
  @Prop({ type: String, default: null, trim: true })
  accountingReceivableAccount: string | null;

  /** This concept's TAX account (`ConceptoCobro.cuentaImpuestoId`), frozen
   *  the same way as `accountingIncomeAccount` — null when the concept has
   *  no tax account configured, or when `taxAmount` is 0. */
  @Prop({ type: String, default: null, trim: true })
  accountingTaxAccount: string | null;

  /** Whether this line came from the unit's standing monthly template, a
   *  one-off novedad for this run, or the computed mora interest line. */
  @Prop({
    required: true,
    enum: ['recurrente', 'novedad', 'interes'],
  })
  source: 'recurrente' | 'novedad' | 'interes';

  /**
   * The NovedadLote this line came from or was replaced by — null for a
   * recurrente/interes line never touched manually. Not one of the frozen
   * facts above: it is a live pointer used while the Lote is still open
   * (editing a line finds it here to know whether to PATCH that novedad or
   * POST a new override), not billing data. On an already-consolidado
   * Factura it is inert history — the NovedadLote it names still lives on
   * the Lote, but nothing reads this field again once issued.
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'NovedadLote', default: null })
  novedadId: Types.ObjectId | null;

  @Prop({ required: true })
  baseAmount: number;

  @Prop({ required: true, default: 0 })
  taxRate: number;

  @Prop({ required: true, default: 0 })
  taxAmount: number;

  @Prop({ required: true })
  totalAmount: number;

  /**
   * This concept's SaldoCartera balance for the unit immediately before and
   * after this line's `totalAmount` was added — frozen at the moment the
   * line was built (consolidación time for a real Factura, "as of right
   * now" for a still-editable FacturaPreliminar), never recomputed later.
   * Lets the printed document show "Saldo Anterior / Nuevo Saldo" per
   * concept the way the predecessor system did, without depending on the
   * live (payment-mutable) SaldoCartera when the PDF is regenerated months
   * afterward. `balanceAfter - balanceBefore` always equals `totalAmount`.
   */
  @Prop({ required: true })
  balanceBefore: number;

  @Prop({ required: true })
  balanceAfter: number;
}

export const FacturaLineaSchema = SchemaFactory.createForClass(FacturaLinea);
