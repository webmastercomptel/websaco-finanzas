import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';
import {
  TIPOS_DOCUMENTO_PRESENTACION,
  type TipoDocumentoPresentacion,
} from './presentacion-documento.schema';

// `mongoose.SchemaTimestampsConfig` is the *options* shape (`timestamps:
// true` accepts it) — not the resulting document's field types, which
// mongoose adds at runtime but the `PlantillaDocumento` class never
// declares. This intersection surfaces `createdAt`/`updatedAt` as real
// `Date`s on the type so the mapper can read `doc.updatedAt` without a
// class field for it — same convention as `InmuebleDocument`.
export type PlantillaDocumentoDocument =
  HydratedDocument<PlantillaDocumento> & {
    createdAt: Date;
    updatedAt: Date;
  };

/**
 * One pdfmake template per document type (`FV`/`RC`/`NC`/`ND`/`NA`/`NT`) —
 * the JSON `docDefinition`, with `{{nombre}}`-style placeholders, that the
 * frontend fills in and renders client-side.
 *
 * Append-only, versioned (see `version`'s own docblock): five of the six
 * types freeze their look forever the moment their PDF is uploaded to
 * Storage (`PresentacionDocumento.objectPath`), so editing this row never
 * touches an already-issued document for them. Factura is the exception — a
 * lone invoice is usually re-rendered live from its own frozen `datos`
 * rather than read back from a file (see `FacturasController
 * .obtenerDocumento`), and a live render needs to know WHICH template
 * version to use, not just which `datos` — this versioning exists for that.
 *
 * PLATFORM-wide, not per coproperty — there is deliberately no
 * `coPropertyId` here, same axis as `EntidadAdministradora`: every
 * coproperty this system serves shares the same six templates, so no
 * customer administrator (however senior) has any business editing one.
 * Gated by `PlatformAdminGuard` at the controller, not CASL/
 * `ConfiguracionModule`, which is for settings scoped to one coproperty.
 *
 * Reuses `TipoDocumentoPresentacion` from `presentacion-documento.schema.ts`
 * rather than a second, near-identical enum — both tables key by "which of
 * the six document kinds is this row about", and a document's frozen
 * printout (`presentacion_documento`) is meaningless without the template
 * (`plantilla_documento`) it was rendered from at the time.
 */
@Schema({ collection: 'plantilla_documento', timestamps: true })
export class PlantillaDocumento {
  @Prop({
    type: String,
    required: true,
    enum: TIPOS_DOCUMENTO_PRESENTACION,
  })
  tipoDocumento: TipoDocumentoPresentacion;

  /** Autoincremented per `tipoDocumento`, starting at 1 — append-only:
   *  `upsert()` always INSERTS a new row with `version = latest + 1`
   *  instead of overwriting in place, so an already-issued Factura can pin
   *  the exact version its own printout used (`PresentacionDocumento
   *  .plantillaVersion`) and reproduce it forever, even after the template
   *  is edited again. `findOne` resolves the highest version (current),
   *  `findVersion` a specific pinned one. */
  @Prop({ type: Number, required: true })
  version: number;

  /**
   * Opaque to this backend on purpose — a pdfmake `docDefinition` tree with
   * Handlebars-style placeholders, exactly as later authored/edited by
   * whoever maintains the templates. Validated only as "is a plain object"
   * at the DTO boundary (`ActualizarPlantillaDocumentoDto`); its internal
   * shape is the frontend's concern, the same way `documentDefinition` was
   * always treated as an opaque blob on `PresentacionDocumento` before this
   * change.
   */
  @Prop({ type: SchemaTypes.Mixed, required: true })
  docDefinition: Record<string, unknown>;
}

export const PlantillaDocumentoSchema =
  SchemaFactory.createForClass(PlantillaDocumento);

PlantillaDocumentoSchema.index(
  { tipoDocumento: 1, version: 1 },
  { unique: true },
);
