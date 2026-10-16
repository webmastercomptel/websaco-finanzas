// src/modules/integraciones-websaco3/dto/consultar-propietarios.dto.ts
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { WEBSACO3_COPROPIEDAD_ID_REGEX } from '../../copropiedades/websaco3-copropiedad-id';

/**
 * Query of the holders pull. Runs AFTER `FirmaWebsaco3Guard`, so the
 * signature was already checked over the id exactly as the caller sent it;
 * the lowercase here only normalizes it for the lookup.
 *
 * Strict shared regex, never `@IsMongoId` (it accepts a `0x`/`0h` prefix).
 * The transform leaves non-strings untouched so a repeated parameter (an
 * array) fails `@IsString` instead of being coerced; no trimming either, so
 * whitespace is a 400, matching the signed value.
 */
export class ConsultarPropietariosDto {
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @Matches(WEBSACO3_COPROPIEDAD_ID_REGEX)
  websaco3CopropiedadId!: string;
}
