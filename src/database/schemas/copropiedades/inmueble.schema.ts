// src/database/schemas/copropiedades/inmueble.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from './copropiedad.schema';
import { Tercero } from '../terceros/tercero.schema';

// `mongoose.SchemaTimestampsConfig` is the *options* shape (`timestamps:
// true` accepts it) — not the resulting document's field types, which
// mongoose adds at runtime but the `Inmueble` class never declares. This
// intersection surfaces `createdAt`/`updatedAt` as real `Date`s on the type
// so the mapper can read `doc.updatedAt` without a class field for it.
export type InmuebleDocument = HydratedDocument<Inmueble> & {
  createdAt: Date;
  updatedAt: Date;
};

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
   * tenancy law in CLAUDE.md.
   */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  copropiedadId: Types.ObjectId;

  /** Identifier as residents use it: "301", "Torre A - 301", "Local 2". */
  @Prop({ required: true, trim: true })
  codigo: string;

  /** Free-text cross-reference to an external record — e.g. this unit's id
   *  in a cadastral registry or the building-management system, when there
   *  is one. Never used to look anything up internally, unlike `codigo`. */
  @Prop({ type: String, default: null, trim: true })
  referencia: string | null;

  /** Tower, block or stage. Null where the property has no such division. */
  @Prop({ type: String, default: null, trim: true })
  bloque: string | null;

  /** Zone and use, as the previous system grouped units. */
  @Prop({ type: String, default: null, trim: true })
  zona: string | null;

  @Prop({ type: String, default: null, trim: true })
  uso: string | null;

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
  coeficiente: number | null;

  /**
   * The party responsible for this unit's charges right now.
   *
   * Past documents do not follow this reference — each one froze the party it
   * was issued to. Changing it redirects future billing and leaves history
   * intact, which is the whole point of keeping units and parties apart.
   */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Tercero.name,
    default: null,
    index: true,
  })
  titularId: Types.ObjectId | null;

  /** Whether the responsible party owns the unit or rents it. */
  @Prop({
    required: true,
    enum: ['propietario', 'arrendatario'],
    default: 'propietario',
  })
  tipoTitular: 'propietario' | 'arrendatario';

  /** Whether the responsible party actually lives here. */
  @Prop({ required: true, default: true })
  resideEnElInmueble: boolean;

  /**
   * Collection status, used to steer follow-up rather than to block billing.
   * A unit in legal proceedings keeps accruing charges; what changes is who
   * chases it. `vigente` means "not escalated to jurídico or difícil
   * recaudo" — it does NOT mean "no arrears": a unit can be a few days
   * overdue and still be `vigente`. Renamed from `al_dia` (Task: aligning
   * the value with that actual meaning — "al día" reads as "no mora",
   * which this status never guaranteed).
   */
  @Prop({
    required: true,
    enum: ['vigente', 'juridico', 'dificil_recaudo'],
    default: 'vigente',
  })
  estadoCartera: 'vigente' | 'juridico' | 'dificil_recaudo';

  /**
   * Who to call about this unit, when that is not the holder — a caretaker, a
   * relative, the tenant of an absent owner. Free text because it is a note to
   * a human, not a record to join on.
   */
  @Prop({ type: String, default: null, trim: true })
  contacto: string | null;

  /**
   * Free notes. Every real property register grows one, and without a field for
   * it the information ends up appended to a name — where it then prints on an
   * invoice.
   */
  @Prop({ type: String, default: null, trim: true })
  observaciones: string | null;

  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  estado: 'active' | 'inactive';
}

export const InmuebleSchema = SchemaFactory.createForClass(Inmueble);

// A unit code repeats across coproperties — "301" exists in every building —
// but must be unique inside one. A plain unique index on `codigo` would
// reject the second building's 301; this compound one is what actually
// models it.
InmuebleSchema.index({ copropiedadId: 1, codigo: 1 }, { unique: true });

/**
 * The index above compares the code byte for byte, so for the database "A1"
 * and "a1" are two different units. The application already refuses that
 * (`InmueblesService.filtroCodigoDuplicado` is case-insensitive), but only
 * for requests that go through it: two concurrent imports in the same
 * coproperty, or any script, could still slip a case variant in.
 *
 * This second unique index closes that gap in the database itself with a
 * case-insensitive collation (strength 2: case-insensitive, accent-sensitive,
 * the same thing the `$options: 'i'` regex lookup does). It has its OWN name
 * so Mongoose creates it on boot next to the existing one, with no drop and
 * no migration script: changing the options of an index that already exists
 * under the same name would be rejected instead. The old index stays, now
 * redundant; it can be dropped later.
 *
 * Not "0301" vs "301": those are different codes on purpose, no collation
 * equates them.
 *
 * If a coproperty ALREADY holds two units whose codes differ only by case,
 * the build fails (the failure is logged, the app keeps running) and the
 * index does not exist until they are fixed. To find them:
 * `db.inmuebles.aggregate([{ $group: { _id: { c: '$copropiedadId',
 * k: { $toLower: '$codigo' } }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])`.
 * An insert that hits it surfaces as the same duplicate-key error, which the
 * import reports row by row as "Código duplicado".
 */
InmuebleSchema.index(
  { copropiedadId: 1, codigo: 1 },
  {
    unique: true,
    name: 'copropiedadId_1_codigo_1_ci',
    collation: { locale: 'en', strength: 2 },
  },
);
