// src/database/schemas/copropiedades/inmueble.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from './copropiedad.schema';
import { Tercero } from '../terceros/tercero.schema';

export type InmuebleDocument = HydratedDocument<Inmueble>;

/**
 * A unit inside a coproperty — what an invoice is addressed to.
 *
 * Only the property itself lives here. Who owns or occupies it is a `Tercero`,
 * referenced below; see that file for why the two are not one record.
 */
@Schema({ timestamps: true, collection: 'inmuebles' })
export class Inmueble {
  /**
   * Owning coproperty. Every query for units MUST filter by this — see the
   * tenancy law in AGENTS.md.
   */
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  /** Identifier as residents use it: "301", "Torre A - 301", "Local 2". */
  @Prop({ required: true, trim: true })
  code: string;

  /** Tower, block or stage. Null where the property has no such division. */
  @Prop({ type: String, default: null, trim: true })
  block: string | null;

  /** Zone, use and cost centre, as the previous system grouped units. */
  @Prop({ type: String, default: null, trim: true })
  zone: string | null;

  @Prop({ type: String, default: null, trim: true })
  usage: string | null;

  @Prop({ type: String, default: null, trim: true })
  costCentre: string | null;

  /** Built area in square metres. */
  @Prop({ type: Number, default: null })
  area: number | null;

  /**
   * Share of the building this unit represents, as a percentage.
   *
   * Load-bearing for anything split proportionally — an extra levy divided
   * across units, a vote weighted by ownership. Stored as given (e.g. 1.8452)
   * rather than pre-rounded: rounding here silently makes the building's shares
   * stop adding up to 100.
   */
  @Prop({ type: Number, default: null })
  participationFactor: number | null;

  /**
   * The party responsible for this unit's charges right now.
   *
   * Past documents do not follow this reference — each one froze the party it
   * was issued to. Changing it redirects future billing and leaves history
   * intact, which is the whole point of keeping units and parties apart.
   */
  @Prop({
    type: Types.ObjectId,
    ref: Tercero.name,
    default: null,
    index: true,
  })
  holderId: Types.ObjectId | null;

  /** Whether the responsible party owns the unit or rents it. */
  @Prop({
    required: true,
    enum: ['propietario', 'arrendatario'],
    default: 'propietario',
  })
  holderKind: 'propietario' | 'arrendatario';

  /** Whether the responsible party actually lives here. */
  @Prop({ required: true, default: true })
  holderResides: boolean;

  /**
   * Collection status, used to steer follow-up rather than to block billing.
   * A unit in legal proceedings keeps accruing charges; what changes is who
   * chases it.
   */
  @Prop({
    required: true,
    enum: ['al_dia', 'juridico', 'dificil_recaudo'],
    default: 'al_dia',
  })
  collectionStatus: 'al_dia' | 'juridico' | 'dificil_recaudo';

  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';
}

export const InmuebleSchema = SchemaFactory.createForClass(Inmueble);

// A unit code repeats across coproperties — "301" exists in every building —
// but must be unique inside one. A plain unique index on `code` would reject
// the second building's 301; this compound one is what actually models it.
InmuebleSchema.index({ coPropertyId: 1, code: 1 }, { unique: true });
