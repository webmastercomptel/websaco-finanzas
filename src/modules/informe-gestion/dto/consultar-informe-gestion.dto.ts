// src/modules/informe-gestion/dto/consultar-informe-gestion.dto.ts
import { IsString, Matches, Validate } from 'class-validator';
import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ValidatorConstraint } from 'class-validator';

const FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const MENSAJE = 'La fecha debe tener el formato AAAA-MM-DD.';

/** Rejects shapes that match the regex but are not real days (2026-13-01, 2026-02-30). */
@ValidatorConstraint({ name: 'fechaDeCalendario', async: false })
class FechaDeCalendario implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    if (typeof valor !== 'string' || !FORMATO.test(valor)) return false;
    const d = new Date(`${valor}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(valor);
  }
  defaultMessage(_args: ValidationArguments): string {
    return MENSAJE;
  }
}

/**
 * Query of `GET /informe-gestion`. The cross-field rule (`validarPeriodo`) is
 * applied by the service, not here.
 */
export class ConsultarInformeGestionDto {
  @IsString({ message: MENSAJE })
  @Matches(FORMATO, { message: MENSAJE })
  @Validate(FechaDeCalendario, { message: MENSAJE })
  desde!: string;

  @IsString({ message: MENSAJE })
  @Matches(FORMATO, { message: MENSAJE })
  @Validate(FechaDeCalendario, { message: MENSAJE })
  hasta!: string;
}
