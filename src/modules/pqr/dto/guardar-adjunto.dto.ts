import { IsIn, IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

/**
 * Content types a PQR attachment may have: photos, PDF and common office
 * documents. Nothing a browser would execute or render as a page (no HTML, no
 * SVG, no XML), because the objects live in the bucket that also holds the
 * Finanzas documents. Checked on the declaration and on the real object.
 */
export const TIPOS_ADJUNTO_PQR: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/**
 * Body of the first step of an attachment upload: declares the file so the
 * backend can register it as `pendiente` and sign a write URL for exactly that
 * content type.
 */
export class CrearAdjuntoPqrDto {
  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsString()
  @IsIn(TIPOS_ADJUNTO_PQR)
  mimeType: string;

  @IsInt()
  @Min(1)
  tamanoBytes: number;
}
