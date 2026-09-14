import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Recibo } from './recibo.schema';
import { Account } from '../cuentas/account.schema';

export type LoteRecibosDocument = HydratedDocument<LoteRecibos>;

/**
 * One row of an uploaded Recibos-por-lote file — one payment for one
 * inmueble. `inmuebleId`/`error` are resolved at `cargarArchivo()` time,
 * never by the frontend: the tenancy law says the tenant (and everything
 * scoped to it, an Inmueble included) is never trusted from client input,
 * only looked up against the ACTIVE coproperty. `copropiedadCodigo` is
 * carried purely as a courtesy cross-check against what the file's author
 * intended — never used to resolve or switch tenant.
 */
@Schema({ _id: false })
export class LoteRecibosFila {
  @Prop({ required: true, trim: true })
  inmuebleCodigo: string;

  @Prop({ type: String, default: null, trim: true })
  copropiedadCodigo: string | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Inmueble.name, default: null })
  inmuebleId: Types.ObjectId | null;

  @Prop({ required: true })
  fechaPago: Date;

  @Prop({ required: true })
  valorRecibido: number;

  /** Set once `aplicar()` successfully creates this row's own Recibo — the
   *  same idempotency marker `Factura`-per-row already uses in
   *  `LoteFacturacion.consolidar()`: a row with a `reciboId` is never
   *  re-processed on a retry. */
  @Prop({ type: SchemaTypes.ObjectId, ref: Recibo.name, default: null })
  reciboId: Types.ObjectId | null;

  /** Why this row cannot be (or could not be) applied — set at
   *  `cargarArchivo()` time for a bad `inmuebleCodigo`, or at `aplicar()`
   *  time if `RecibosService.crear()` itself rejects it (period closed,
   *  lote de facturación abierto, etc.). `null` means no known problem. */
  @Prop({ type: String, default: null, trim: true })
  error: string | null;
}

export const LoteRecibosFilaSchema =
  SchemaFactory.createForClass(LoteRecibosFila);

/**
 * A batch of Recibos de Caja uploaded from a flat file (a bank's own
 * consignación masiva report) instead of keyed in one at a time —
 * `borrador` → `cargado` → `aplicado`, the same three-stage shape
 * `LoteFacturacion` already uses for its own batch lifecycle. Each row
 * becomes its own real `Recibo`, applied automatically (FIFO) via
 * `RecibosService.crear()` — this schema owns no cruce logic of its own,
 * only the batch bookkeeping (which rows, whether the declared total
 * matches, which row became which Recibo).
 */
@Schema({ timestamps: true, collection: 'lotes_recibos' })
export class LoteRecibos {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ required: true })
  number: number;

  @Prop({
    required: true,
    enum: ['borrador', 'cargado', 'aplicado'],
    default: 'borrador',
  })
  status: 'borrador' | 'cargado' | 'aplicado';

  /** Tipo de documento (código) every Recibo in this lote is numbered
   *  under — common to the whole batch, same as medioPago/cuentaDestino
   *  below (the file only ever carries what varies per row). */
  @Prop({ required: true, trim: true })
  codigo: string;

  @Prop({
    required: true,
    enum: ['transferencia', 'cheque', 'pse', 'efectivo'],
  })
  medioPago: 'transferencia' | 'cheque' | 'pse' | 'efectivo';

  @Prop({ type: String, default: null, trim: true })
  cuentaDestino: string | null;

  /** What the user typed as the expected total — `cargarArchivo()`
   *  validates the file's own sum against this before letting the lote
   *  move to `cargado`. */
  @Prop({ required: true })
  totalDigitado: number;

  @Prop({ type: [LoteRecibosFilaSchema], required: true, default: [] })
  filas: LoteRecibosFila[];

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;

  /** When this batch was created — a domain field set explicitly at
   *  `crear()` time, deliberately NOT the same thing as Mongoose's own
   *  `timestamps: true` bookkeeping (`createdAt` below): that one tracks the
   *  document's own persistence history and is not meant to leak into the
   *  API contract, this one is business data the frontend actually shows. */
  @Prop({ required: true })
  creadoEn: Date;
}

export const LoteRecibosSchema = SchemaFactory.createForClass(LoteRecibos);

// At most one batch in flight per coproperty at a time — same reasoning as
// LoteFacturacion's own index: a second one open at once would make "which
// lote am I cargando" ambiguous.
LoteRecibosSchema.index(
  { coPropertyId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['borrador', 'cargado'] } },
    name: 'unico_lote_recibos_en_curso_por_copropiedad',
  },
);
