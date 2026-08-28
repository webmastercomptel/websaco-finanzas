// src/database/schemas/cuentas/asignacion.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { EntidadAdministradora } from '../entidades/entidad-administradora.schema';
import { Account } from './account.schema';

export type AsignacionDocument = HydratedDocument<Asignacion>;

/**
 * Grants one account the right to operate coproperties, with a set of
 * permissions.
 *
 * This collection answers two questions, and it matters that the answer is the
 * same one:
 *
 *  - Which coproperties does the picker offer after signing in?
 *  - Is the `X-CoProperty-Id` on this request one this caller may use?
 *
 * The second is checked on EVERY request. A choice the browser remembers is a
 * request, never a grant, so an assignment revoked five minutes ago has to stop
 * working now — see the tenancy law in AGENTS.md.
 *
 * A grant has one of two shapes:
 *
 *  - `copropiedad` — this one building. Exact and independent of who
 *    administers it.
 *  - `entidad` — every building that company administers, including ones it
 *    takes on later. This is what keeps a firm with ten or more properties from
 *    maintaining its staff's access building by building.
 *
 * Both shapes may coexist for the same person: assigned to a company, plus one
 * extra building it does not administer. Resolving access is therefore a union,
 * never a lookup of one row.
 */
@Schema({ timestamps: true, collection: 'asignaciones' })
export class Asignacion {
  @Prop({
    type: Types.ObjectId,
    ref: Account.name,
    required: true,
    index: true,
  })
  accountId: Types.ObjectId;

  /** Which of the two shapes this grant is. */
  @Prop({ required: true, enum: ['copropiedad', 'entidad'] })
  scope: 'copropiedad' | 'entidad';

  /** Set when scope is `copropiedad`, null otherwise. */
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    default: null,
    index: true,
  })
  coPropertyId: Types.ObjectId | null;

  /** Set when scope is `entidad`, null otherwise. */
  @Prop({
    type: Types.ObjectId,
    ref: EntidadAdministradora.name,
    default: null,
    index: true,
  })
  entidadId: Types.ObjectId | null;

  /**
   * Permission keys in `modulo.accion` form, e.g. `facturas.anular`. Translated
   * to CASL rules in exactly one place — modules/casl/permission-map.ts.
   *
   * Held directly rather than through a role, because a role is a convenience
   * for granting the same set to many people and there is nobody to grant it to
   * yet. When repeating these lists starts to hurt, a role becomes a named
   * bundle that fills this array — it does not replace it.
   *
   * With an `entidad` grant these permissions apply in every building the
   * company administers. There is no per-building variation inside one grant;
   * somebody who should do less in one property gets a narrower direct
   * assignment there.
   */
  @Prop({ type: [String], required: true, default: [] })
  permissions: string[];

  /**
   * Inactive revokes access while keeping the record of who once had it. Do not
   * delete assignments: "who could touch this building last March" is a
   * question an auditor will eventually ask.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';
}

export const AsignacionSchema = SchemaFactory.createForClass(Asignacion);

// One grant per account per target. Two rows for the same pair would split a
// person's permissions across records, and which one wins would depend on read
// order. Partial indexes because the unused column is null on every row of the
// other shape, and a plain compound unique index would collide on those nulls.
AsignacionSchema.index(
  { accountId: 1, coPropertyId: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'copropiedad' },
  },
);

AsignacionSchema.index(
  { accountId: 1, entidadId: 1 },
  {
    unique: true,
    partialFilterExpression: { scope: 'entidad' },
  },
);

// Guards the shape itself: a grant must name exactly the target its scope says
// it does. Without this, a row with scope 'entidad' and only a coPropertyId
// would save happily and then grant nothing, which reads as "the permission
// system is broken" rather than "this row is malformed".
// Written as a zero-argument hook that throws, rather than the `next(err)`
// form: Mongoose decides how to call a hook from its arity, and the callback
// style is easy to get subtly wrong — a missing `next()` on the happy path
// hangs every save forever, silently. Throwing cannot be half-done.
//
// It stays `async` with nothing awaited on purpose. Mongoose treats a
// promise-returning hook as async middleware and awaits it; dropping the
// keyword would change how the hook is invoked, not just how it reads.
/* eslint-disable-next-line @typescript-eslint/require-await */
AsignacionSchema.pre('validate', async function () {
  const esCopropiedad = this.scope === 'copropiedad';
  const tieneCopropiedad = this.coPropertyId != null;
  const tieneEntidad = this.entidadId != null;

  if (esCopropiedad && (!tieneCopropiedad || tieneEntidad)) {
    throw new Error(
      'Una asignación de alcance "copropiedad" debe llevar coPropertyId y no entidadId.',
    );
  }
  if (!esCopropiedad && (!tieneEntidad || tieneCopropiedad)) {
    throw new Error(
      'Una asignación de alcance "entidad" debe llevar entidadId y no coPropertyId.',
    );
  }
});
