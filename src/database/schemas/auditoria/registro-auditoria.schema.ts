// src/database/schemas/auditoria/registro-auditoria.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Account } from '../cuentas/account.schema';

export type RegistroAuditoriaDocument = HydratedDocument<RegistroAuditoria>;

/**
 * Append-only audit log for platform-level mutations.
 *
 * Each entry records that a create or update happened, by whom, on what
 * entity — not what changed field by field. This is the first version:
 * field-level diffs are YAGNI until a concrete need surfaces.
 *
 * Not scoped by tenant — these events happen above any single coproperty,
 * same as the Entidades/Copropiedades/Usuarios catalogs themselves.
 */
@Schema({ timestamps: true, collection: 'audit_log_entries' })
export class RegistroAuditoria {
  @Prop({
    type: Types.ObjectId,
    ref: Account.name,
    required: true,
    index: true,
  })
  actorAccountId: Types.ObjectId;

  /** Denormalized at write time — the actor's name can change afterward. */
  @Prop({ required: true, trim: true })
  actorNombre: string;

  @Prop({ required: true, enum: ['crear', 'actualizar'] })
  accion: 'crear' | 'actualizar';

  @Prop({
    required: true,
    enum: ['entidad-administradora', 'copropiedad', 'usuario'],
    index: true,
  })
  entidadTipo: 'entidad-administradora' | 'copropiedad' | 'usuario';

  @Prop({ type: Types.ObjectId, required: true, index: true })
  entidadId: Types.ObjectId;

  /**
   * Denormalized display label at write time — the entity's own name/code
   * may change later, and this reads exactly what the mockup's "Entity /
   * User" column needs without a join.
   */
  @Prop({ required: true, trim: true })
  entidadEtiqueta: string;
}

export const RegistroAuditoriaSchema =
  SchemaFactory.createForClass(RegistroAuditoria);

RegistroAuditoriaSchema.index({ createdAt: -1 });
