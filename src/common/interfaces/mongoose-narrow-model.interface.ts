// src/common/interfaces/mongoose-narrow-model.interface.ts
import type { ClientSession, QueryFilter } from 'mongoose';

/**
 * Structural substitutes for `mongoose.Model<T>`, describing only the exact
 * method chain a given call site actually uses.
 *
 * Mongoose 9.10 narrowed how `Model<T>`'s hydrated-document type resolves
 * (`AddDefaultId` in `mongoose/types/inferschematype.d.ts` now branches on
 * whether the raw doc type already carries an `id` field). A concrete model
 * — this codebase's own field-declaration convention is `Model<XDocument>`,
 * e.g. `Model<FacturaDocument>` — is no longer assignable to some OTHER,
 * independently parameterized `Model<U>` (a generic helper's own narrow
 * view, or a map of several models under one key type): that assignment
 * requires comparing EVERY overload of `Model`'s methods, including
 * projection-argument overloads no caller here ever uses, whose return
 * types resolve through a conditional (`ProjectedHydratedDocument`) that,
 * with an unresolved `Projection` type parameter, produces union branches
 * missing the schema's `id` virtual — even though the single-argument call
 * every one of these call sites actually makes never reaches that code
 * path at runtime ("Property 'id' is missing" errors after the 9.10
 * upgrade).
 *
 * Describing just the ONE overload actually called (single-argument
 * `find`/`findOne`/`deleteMany`, `.session()`, `.lean()`, `.exec()`)
 * sidesteps that whole incompatible surface: TypeScript only has to match
 * one simple signature, which any concrete model's own general fallback
 * overload satisfies naturally, whatever its own `Model<...>` field
 * declaration looks like.
 */

/**
 * `.find(filter, projection).lean().exec()` — a plain read that never
 * touches a hydrated document afterward. Used by
 * `DocumentosService.getHighestIssuedNumber`'s per-category model map.
 */
export interface LeanFindModel<T> {
  // A plain `Record` filter, not `QueryFilter<T>`: every call site filters
  // on `coPropertyId` alongside `T`'s own fields (`fullNumber`), a key
  // `QueryFilter<T>` would reject as foreign to this narrow `T`.
  find(
    filter: Record<string, unknown>,
    projection?: Record<string, 0 | 1> | null,
  ): {
    lean(): {
      exec(): Promise<T[]>;
    };
  };
}

/**
 * `.findOne(filter).session(session).exec()` — the "load the origin/target
 * document inside this transaction" call shared by `cruce.util.ts`'s
 * `decrementarSaldoDocumentoOrigen` and `NotasAnticipoService.crearSobreOrigen`
 * (via `ContextoAplicacion.recibos`).
 */
export interface SessionFindOneModel<T> {
  findOne(filter: QueryFilter<T>): {
    session(session: ClientSession | null): {
      exec(): Promise<T | null>;
    };
  };
}

/**
 * `.deleteMany(filter)` — `clear-demo.ts`'s own generic per-collection wipe
 * helper, which never reads anything back beyond `deletedCount`.
 */
export interface DeleteManyModel {
  deleteMany(filter: Record<string, never>): Promise<{ deletedCount: number }>;
}
