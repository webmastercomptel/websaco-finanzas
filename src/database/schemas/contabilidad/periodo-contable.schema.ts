// src/database/schemas/contabilidad/periodo-contable.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type PeriodoContableDocument = HydratedDocument<PeriodoContable>;

/**
 * One accounting month for one coproperty, and whether it still accepts entries.
 *
 * Property-management accounting closes strictly month by month. Once the month
 * is closed and its statements have gone to the council, nothing may be posted
 * into it again: altering January while standing in February would contradict
 * reports already handed over and move the opening balances of every month
 * after it.
 *
 * The rule that follows is the one worth memorising, because it is not obvious
 * and every correction depends on it: **an error found in March on a January
 * invoice is fixed with a credit note dated MARCH that references the January
 * invoice.** You post into the open period and point backwards. You never
 * reach back.
 *
 * A month with no row here is open. Periods are created when they are closed,
 * so an untouched building can be billed without somebody first having to
 * manufacture twelve rows a year.
 */
@Schema({ timestamps: true, collection: 'periodos_contables' })
export class PeriodoContable {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  /** Four digits. */
  @Prop({ required: true })
  year: number;

  /** 1–12. Stored as a number so ordering is arithmetic, not string order. */
  @Prop({ required: true, min: 1, max: 12 })
  month: number;

  @Prop({ required: true, enum: ['abierto', 'cerrado'], default: 'abierto' })
  status: 'abierto' | 'cerrado';

  @Prop({ type: Date, default: null })
  closedAt: Date | null;

  /** Who closed it. A closed month is somebody's decision, not an event. */
  @Prop({
    type: Types.ObjectId,
    ref: Account.name,
    default: null,
  })
  closedByAccountId: Types.ObjectId | null;
}

export const PeriodoContableSchema =
  SchemaFactory.createForClass(PeriodoContable);

// One row per month per building, and the lookup every document write performs.
PeriodoContableSchema.index(
  { coPropertyId: 1, year: 1, month: 1 },
  { unique: true },
);
