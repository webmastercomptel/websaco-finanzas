import { IsDateString, IsIn, Matches } from 'class-validator';
import {
  RESPONSABLES_PQR,
  TIPOS_PQR,
  type ResponsablePqr,
  type TipoPqr,
} from '../../../database/schemas/administracion/pqr.schema';

/**
 * Body of the classification step: what kind of PQR it really is, who answers
 * it and the response deadline (a `YYYY-MM-DD` Bogotá day the administrator
 * confirms or edits from the suggested one).
 */
export class ClasificarPqrDto {
  @IsIn(TIPOS_PQR)
  tipo: TipoPqr;

  @IsIn(RESPONSABLES_PQR)
  responsable: ResponsablePqr;

  // `strict` makes the ISO check reject impossible calendar days (2026-02-30).
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fechaLimite: string;
}
