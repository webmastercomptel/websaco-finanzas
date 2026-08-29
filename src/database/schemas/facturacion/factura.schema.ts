import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
// import { LoteFacturacion } from './lote-facturacion.schema'; // TODO: Task 4
import { ResolucionFacturacion } from '../numeracion/resolucion-facturacion.schema';
import {
  FacturaLinea,
  FacturaLineaSchema,
  TitularCongelado,
  TitularCongeladoSchema,
} from './factura-linea.schema';

export type FacturaDocument = HydratedDocument<Factura>;

/**
 * A sales invoice ("FV"). Only ever created already-numbered, at the moment
 * a LoteFacturacion is consolidated — there is no draft Factura. While a
 * unit's invoice is being prepared it lives as a FacturaPreliminar embedded
 * in its Lote (see lote-facturacion.schema.ts); a Factura row appearing at
 * all means NumeracionService already reserved its number.
 */
@Schema({ timestamps: true, collection: 'facturas' })
export class Factura {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    // ref: LoteFacturacion.name, // TODO: Task 4
    required: true,
    index: true,
  })
  loteId: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  /** Frozen — see the note on Tercero's schema for why a unit's code
   *  changing later must not alter an already-issued document. */
  @Prop({ required: true, trim: true })
  inmuebleCodigo: string;

  @Prop({ type: Types.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  @Prop({ type: TitularCongeladoSchema, default: null })
  titular: TitularCongelado | null;

  @Prop({
    type: Types.ObjectId,
    ref: ResolucionFacturacion.name,
    required: true,
  })
  resolucionId: Types.ObjectId;

  @Prop({ required: true, trim: true, default: '' })
  prefijo: string;

  @Prop({ required: true })
  numero: number;

  @Prop({ required: true, trim: true })
  numeroCompleto: string;

  @Prop({ required: true })
  fechaEmision: Date;

  @Prop({ required: true })
  fechaVencimiento: Date;

  @Prop({ required: true })
  periodoDesde: Date;

  @Prop({ required: true })
  periodoHasta: Date;

  @Prop({ type: [FacturaLineaSchema], required: true, default: [] })
  lineas: FacturaLinea[];

  @Prop({ required: true })
  subtotal: number;

  @Prop({ required: true, default: 0 })
  totalImpuestos: number;

  @Prop({ required: true })
  total: number;

  /** The one mutable field on an otherwise immutable document. Starts equal
   *  to `total`; a future Recibo decreases it. */
  @Prop({ required: true })
  saldoPendiente: number;

  @Prop({ required: true, enum: ['emitida', 'anulada'], default: 'emitida' })
  estado: 'emitida' | 'anulada';

  /** Exists now so voiding, once NotaCredito is designed, fills this field
   *  instead of migrating the schema. */
  @Prop({ type: Types.ObjectId, default: null })
  anuladaPorNotaCreditoId: Types.ObjectId | null;
}

export const FacturaSchema = SchemaFactory.createForClass(Factura);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), but a compound index here makes
// that guarantee visible to the database too, not just to the code path
// that happens to be the only writer today.
FacturaSchema.index({ coPropertyId: 1, numeroCompleto: 1 }, { unique: true });
