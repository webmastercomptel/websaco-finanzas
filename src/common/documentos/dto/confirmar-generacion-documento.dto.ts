import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of every `POST <ruta>/:id/confirmar-generacion` route across the six
 * document types — the frontend's claim that it finished uploading the PDF
 * `solicitar-generacion` handed it a signed URL for. Shared across modules
 * because the shape is identical everywhere: `PresentacionDocumentoService
 * .confirmarGeneracion` never trusts this on its own (it re-verifies the
 * object actually exists in the bucket), so there is nothing document-type
 * specific to validate here beyond "a non-empty string was sent".
 */
export class ConfirmarGeneracionDocumentoDto {
  @IsString()
  @IsNotEmpty()
  objectPath: string;
}
