import {
  IsArray,
  IsDateString,
  IsIn,
  IsMongoId,
  IsOptional,
} from 'class-validator';
import { Transform } from 'class-transformer';

const TIPOS_VALIDOS = ['FC', 'RC', 'NC', 'ND', 'NT'] as const;

/** A single checked checkbox arrives as `?tipos=FC` — Express's default `qs`
 *  parser only produces an array when the same query key repeats
 *  (`?tipos=FC&tipos=RC`); a lone occurrence is a bare string, which
 *  `@IsArray()` would otherwise reject with a 400 the moment a user narrows
 *  the type filter down to exactly one checkbox. */
const aArreglo = ({ value }: { value: unknown }): unknown =>
  value === undefined || Array.isArray(value) ? value : [value];

export class ListarAuxiliarCarteraDto {
  @IsMongoId()
  inmuebleId!: string;

  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;

  @IsOptional()
  @Transform(aArreglo)
  @IsArray()
  @IsIn(TIPOS_VALIDOS, { each: true })
  tipos?: ('FC' | 'RC' | 'NC' | 'ND' | 'NT')[];
}
