// src/modules/usuarios/dto/guardar-usuario.dto.ts
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Creating a user provisions BOTH a Firebase sign-in identity and the local
 * Account/Asignacion that decide what they may do — see
 * FirebaseUsuariosService for why this is the one place in the app allowed to
 * write to Firebase.
 *
 * A platform administrator needs no assignment (`alcance` is skipped
 * entirely when `esAdministradorPlataforma` is true — see
 * `rulesFromPermissionKeys`'s `manage all`). Anyone else must be pointed
 * somewhere: "created with no assignment" is indistinguishable from "created
 * and then forgotten," and the form should not allow shipping that by
 * accident.
 */
export class CrearUsuarioDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre: string;

  @IsEmail()
  email: string;

  /** Firebase's own floor. Enforced here too so the error names the field. */
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password: string;

  @IsOptional()
  @IsBoolean()
  esAdministradorPlataforma?: boolean;

  @ValidateIf((o: CrearUsuarioDto) => !o.esAdministradorPlataforma)
  @IsIn(['copropiedad', 'entidad'])
  alcance?: 'copropiedad' | 'entidad';

  @ValidateIf((o: CrearUsuarioDto) => o.alcance === 'copropiedad')
  @IsMongoId()
  copropiedadId?: string;

  @ValidateIf((o: CrearUsuarioDto) => o.alcance === 'entidad')
  @IsMongoId()
  entidadId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permisos?: string[];
}

/**
 * Editing a user. Every field optional except that a scope, once given,
 * still needs its target — the same reasoning as creation.
 *
 * `estado` here is the only way a user account is retired: `inactivo` mirrors
 * to Firebase as `disabled: true` (see UsuariosService.update), an immediate
 * lockout, never a deletion — the same audit law as everywhere else applies
 * to identities too.
 *
 * `nuevaPassword` is a distinct, optional action bundled into the same PATCH
 * for convenience: a platform administrator resetting a forgotten password on
 * someone's behalf, without needing separate console access now that this
 * screen exists.
 */
export class ActualizarUsuarioDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsBoolean()
  esAdministradorPlataforma?: boolean;

  @IsOptional()
  @IsIn(['copropiedad', 'entidad'])
  alcance?: 'copropiedad' | 'entidad';

  @ValidateIf((o: ActualizarUsuarioDto) => o.alcance === 'copropiedad')
  @IsMongoId()
  copropiedadId?: string;

  @ValidateIf((o: ActualizarUsuarioDto) => o.alcance === 'entidad')
  @IsMongoId()
  entidadId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permisos?: string[];

  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  nuevaPassword?: string;
}
