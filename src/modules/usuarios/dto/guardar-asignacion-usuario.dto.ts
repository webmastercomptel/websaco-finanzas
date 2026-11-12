// src/modules/usuarios/dto/guardar-asignacion-usuario.dto.ts
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { MAX_CLAVES_ASIGNABLES } from '../../casl/permisos-catalogo';

/**
 * Adds ONE assignment to an account, from the platform Usuarios screen.
 *
 * The row is always created `administrativo` and active with no roles, so
 * neither `perfil`, `roleIds` nor `estado` is accepted (the global whitelist
 * answers 400). `permisos` is required: an empty list is valid and stores a
 * row that grants nothing yet. The cap of the list and of each key is the same
 * as Equipo's and Roles', derived from the catalogs and never a literal, so a
 * request that ticks every box always fits.
 *
 * Only the id that matches `alcance` is read: the other one carries no rule, and
 * the service ignores it.
 */
export class AgregarAsignacionUsuarioDto {
  @IsIn(['copropiedad', 'entidad'])
  alcance: 'copropiedad' | 'entidad';

  @ValidateIf((o: AgregarAsignacionUsuarioDto) => o.alcance === 'copropiedad')
  @IsMongoId()
  copropiedadId?: string;

  @ValidateIf((o: AgregarAsignacionUsuarioDto) => o.alcance === 'entidad')
  @IsMongoId()
  entidadId?: string;

  @IsArray()
  @ArrayMaxSize(MAX_CLAVES_ASIGNABLES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permisos: string[];
}

/**
 * Edits ONE assignment of an account: its keys, its state, or both. At least
 * one must travel. The target (`alcance`, `copropiedadId`, `entidadId`), the
 * `perfil` and the roles are not editable, so any of them answers 400 through
 * the global whitelist: "move" a person is adding the new target and
 * deactivating the old one.
 *
 * `estado: 'activo'` alone is a valid reactivation (the stored keys are kept),
 * and `estado: 'inactivo'` with `permisos` deactivates and stores those keys.
 */
export class ActualizarAsignacionUsuarioDto {
  /**
   * Required unless `estado` travels alone. The condition also fires when both
   * travel, so a malformed list next to an `estado` is still judged:
   * `ValidateIf` skips EVERY validator of the property when it is false.
   */
  @ValidateIf(
    (o: ActualizarAsignacionUsuarioDto) =>
      o.estado === undefined || o.permisos !== undefined,
  )
  @IsArray({ message: 'Indica los permisos, el estado o ambos' })
  @ArrayMaxSize(MAX_CLAVES_ASIGNABLES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permisos?: string[];

  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';
}
