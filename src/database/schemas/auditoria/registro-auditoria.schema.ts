// src/database/schemas/auditoria/registro-auditoria.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Account } from '../cuentas/account.schema';

export type RegistroAuditoriaDocument = HydratedDocument<RegistroAuditoria>;

/** Keys an audited write added and removed from a permission set. */
@Schema({ _id: false })
export class DetalleAuditoria {
  @Prop({ type: [String], default: [] })
  agregadas: string[];

  @Prop({ type: [String], default: [] })
  quitadas: string[];
}

const DetalleAuditoriaSchema = SchemaFactory.createForClass(DetalleAuditoria);

/**
 * Append-only audit log for platform-level mutations.
 *
 * Each entry records that a create, update, reversal (`revertir`), cycle
 * reset (`reiniciar`) or unit retirement (`dar-de-baja`, entity type
 * `inmueble`: one entry per batch, written in the same transaction as the
 * retirement) happened, by whom, on what
 * entity — not what changed field by field. The one exception is `detalle`:
 * the permission keys a team or role write added and removed, because "who
 * gave whom what" is the question an access audit exists to answer.
 *
 * Not scoped by tenant — these events happen above any single coproperty,
 * same as the Entidades/Copropiedades/Usuarios catalogs themselves.
 */
@Schema({ timestamps: true, collection: 'audit_log_entries' })
export class RegistroAuditoria {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Account.name,
    required: true,
    index: true,
  })
  actorAccountId: Types.ObjectId;

  /** Denormalized at write time — the actor's name can change afterward. */
  @Prop({ required: true, trim: true })
  actorNombre: string;

  @Prop({
    required: true,
    enum: [
      'crear',
      'actualizar',
      'revertir',
      'reiniciar',
      'desmarcar',
      'dar-de-baja',
      'retirar',
      'marcar-envio',
      'enviar',
      'eliminar',
      'restablecer',
    ],
  })
  accion:
    | 'crear'
    | 'actualizar'
    | 'revertir'
    | 'reiniciar'
    | 'desmarcar'
    | 'dar-de-baja'
    | 'retirar'
    | 'marcar-envio'
    | 'enviar'
    | 'eliminar'
    | 'restablecer';

  @Prop({
    required: true,
    enum: [
      'entidad-administradora',
      'copropiedad',
      'usuario',
      'lote-facturacion',
      'lote-contabilidad',
      'inmueble',
      'lote-comptable',
      'envio-factura',
      'rol',
      'acceso-residente',
    ],
    index: true,
  })
  entidadTipo:
    | 'entidad-administradora'
    | 'copropiedad'
    | 'usuario'
    | 'lote-facturacion'
    | 'lote-contabilidad'
    | 'inmueble'
    | 'lote-comptable'
    | 'envio-factura'
    | 'rol'
    | 'acceso-residente';

  @Prop({ type: SchemaTypes.ObjectId, required: true, index: true })
  entidadId: Types.ObjectId;

  /**
   * Denormalized display label at write time — the entity's own name/code
   * may change later, and this reads exactly what the mockup's "Entity /
   * User" column needs without a join.
   */
  @Prop({ required: true, trim: true })
  entidadEtiqueta: string;

  /**
   * Which permission keys the write added and removed (the sets the delegation
   * cap judged, sorted). Optional: entries written before it existed, and
   * actions that touch no keys, simply do not carry it. A sub-schema rather
   * than a nested path on purpose: a nested path would make Mongoose fill
   * `{ agregadas: [], quitadas: [] }` into every old entry on read, and
   * "no detail" would become indistinguishable from "nothing changed".
   */
  @Prop({ type: DetalleAuditoriaSchema, required: false })
  detalle?: DetalleAuditoria;
}

export const RegistroAuditoriaSchema =
  SchemaFactory.createForClass(RegistroAuditoria);

RegistroAuditoriaSchema.index({ createdAt: -1 });
