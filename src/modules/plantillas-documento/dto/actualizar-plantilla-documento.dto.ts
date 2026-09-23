import { IsObject } from 'class-validator';

/**
 * `docDefinition` is validated only as "a plain object" — its pdfmake/
 * Handlebars internals are intentionally opaque to this backend, the same
 * way `documentDefinition` was always treated as an opaque blob on
 * `PresentacionDocumento` before this change. A deeper shape check here
 * would tie this backend to a template structure it has no business
 * understanding.
 */
export class ActualizarPlantillaDocumentoDto {
  @IsObject()
  docDefinition: Record<string, unknown>;
}
