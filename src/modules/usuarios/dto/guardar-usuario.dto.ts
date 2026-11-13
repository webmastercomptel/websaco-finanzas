// src/modules/usuarios/dto/guardar-usuario.dto.ts
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * 24 hex characters and nothing else. `@IsMongoId` also accepts a `0x` prefix
 * plus 22 hex characters, which `new Types.ObjectId` then refuses with a 500.
 */
const ID_HEX = /^[0-9a-fA-F]{24}$/;

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
 *
 * There is no `perfil`: this screen only ever writes `administrativo` rows (the
 * `personal` ones belong to Equipo), so a body carrying it answers 400 through
 * the global whitelist.
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
  @Matches(ID_HEX, { message: 'copropiedadId no es un identificador válido' })
  copropiedadId?: string;

  @ValidateIf((o: CrearUsuarioDto) => o.alcance === 'entidad')
  @Matches(ID_HEX, { message: 'entidadId no es un identificador válido' })
  entidadId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permisos?: string[];
}

/**
 * Editing a user's ACCOUNT, nothing else. The assignments are managed one row
 * at a time through `POST /usuarios/:id/asignaciones` and
 * `PATCH /usuarios/:id/asignaciones/:asignacionId`, so `alcance`, the target
 * ids, `permisos` and `perfil` are not accepted here (the global whitelist
 * answers 400): a save of the account can never replace, move or retire a row.
 *
 * `estado` here is the only way a user account is retired: `inactivo` mirrors
 * to Firebase as `disabled: true` (see UsuariosService.update), an immediate
 * lockout, never a deletion — the same audit law as everywhere else applies
 * to identities too. It acts on the identity, not on the rows, which keep their
 * own `estado`.
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
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  nuevaPassword?: string;
}
