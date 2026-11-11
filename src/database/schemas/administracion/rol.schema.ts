// src/database/schemas/administracion/rol.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RolDocument = HydratedDocument<Rol>;

/**
 * A named bundle of permission keys, owned by ONE coproperty (the building's
 * administrator edits it and assigns it to staff).
 *
 * It is not a second authorization system: an `Asignacion` of that coproperty
 * lists role ids, and `AccesoService` unions the role's keys into the
 * assignment's own `permisos` when resolving access. Everything downstream still
 * sees one flat key list translated by `permission-map.ts`.
 *
 * A role may hold any offered key, Finanzas and Administración alike. What stops
 * whoever edits roles from widening anyone's access is the delegation cap on the
 * write (`RolesService`, `casl/delegacion.ts`): they can only put into a role, or
 * take out of it, keys they hold themselves.
 */
@Schema({ timestamps: true, collection: 'adm_roles', versionKey: false })
export class Rol {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  /** `ROL-001`, sequenced per coproperty. */
  @Prop({ default: '' })
  codigo: string;

  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ default: '' })
  descripcion: string;

  @Prop({ default: '#64748b' })
  color: string;

  /** Pre-selected when creating a user in the screen; no authorization meaning. */
  @Prop({ default: false })
  esPredeterminado: boolean;

  @Prop({ type: [String], default: [] })
  permisos: string[];
}

export const RolSchema = SchemaFactory.createForClass(Rol);

// A name is unique within a coproperty, ignoring case: "Portero" and "portero"
// are the same role.
RolSchema.index(
  { copropiedadId: 1, nombre: 1 },
  { unique: true, collation: { locale: 'es', strength: 2 } },
);
RolSchema.index({ copropiedadId: 1, codigo: 1 });
