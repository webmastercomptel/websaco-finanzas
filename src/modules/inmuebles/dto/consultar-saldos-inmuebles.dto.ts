// src/modules/inmuebles/dto/consultar-saldos-inmuebles.dto.ts
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
} from 'class-validator';

/**
 * Query for `GET /inmuebles/saldos?ids=a,b,c`.
 *
 * A query string cannot carry an array natively, so the ids travel as one
 * comma-separated value. The transform also accepts the repeated form
 * (`?ids=a&ids=b`, which Express parses into an array) so either client style
 * works. Anything that is not a string (or array of strings) is left untouched
 * and rejected by `@IsArray`/`@IsMongoId` rather than coerced into something
 * plausible. The cap of 50 keeps the answer a bounded, page-sized lookup.
 */
export class ConsultarSaldosInmueblesDto {
  @Transform(({ value }: { value: unknown }): unknown => {
    const crudos: unknown[] = Array.isArray(value) ? value : [value];
    if (!crudos.every((v) => typeof v === 'string')) return value;
    return crudos
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  ids!: string[];
}
