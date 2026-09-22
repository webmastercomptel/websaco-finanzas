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
 * frontend fills in and renders client-side. There is no version history: a
 * template is edited in place, and that is safe precisely because it never
 * governs how an ALREADY-emitted document looks — that immutability comes
 * from the frozen file in Storage (`PresentacionDocumento.objectPath`), not
 * from this row. Editing a template today only changes what the NEXT
 * document of that type renders as.
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
    unique: true,
  })
  tipoDocumento: TipoDocumentoPresentacion;

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
