// src/modules/copropiedades/dto/guardar-copropiedad.dto.ts
import {
  IsBoolean,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Everything about a coproperty except its code, all optional. Split the same
 * way as the Inmuebles DTOs: creating requires a code, editing does not, and a
 * subclass cannot relax a parent's required field into an optional one.
 */
class CamposCopropiedadDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  nit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  digitoVerificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  direccion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  ciudad?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  telefono?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  /**
   * The managing entity, when there is one. Mutually exclusive with
   * `nombreAdministrador` in practice — a building either has a company on
   * file or carries a plain-text note instead — but not enforced here, since
   * setting one and clearing the other is exactly what an edit does. Neither
   * field is an authorization record: who actually administers the building
   * is a person, assigned through Usuarios.
   */
  @IsOptional()
  @IsMongoId()
  entidadAdministradoraId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombreAdministrador?: string;

  @IsOptional()
  @IsBoolean()
  usaGestionEdificios?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cuentaContableCartera?: string;
}

export class CrearCopropiedadDto extends CamposCopropiedadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;
}

/**
 * `estado` is here, and it is the only way a coproperty is retired:
 * `inactivo` means "stop billing it", never "delete it" — its invoices and
 * receipts must stay readable forever. There is no delete endpoint.
 */
export class ActualizarCopropiedadDto extends CamposCopropiedadDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo?: string;

  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';
}
