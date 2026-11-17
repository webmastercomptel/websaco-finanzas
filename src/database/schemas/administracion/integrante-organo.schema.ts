// src/database/schemas/administracion/integrante-organo.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type IntegranteOrganoDocument = HydratedDocument<IntegranteOrgano>;

/** The bodies a coproperty keeps a member list for. */
export const ORGANOS_COPROPIEDAD = ['consejo', 'comite_convivencia'] as const;

export type OrganoCopropiedad = (typeof ORGANOS_COPROPIEDAD)[number];

/** Display name of each body, used in messages and audit labels. */
export const ETIQUETA_ORGANO: Record<OrganoCopropiedad, string> = {
  consejo: 'Consejo de Administración',
  comite_convivencia: 'Comité de Convivencia',
};

/**
 * A party (owner or tenant) seated in a body of ONE coproperty. Only the link
 * is stored: name, e-mails and units are read live from the party and its
 * units, so a record edit is never stale here.
 */
@Schema({
  timestamps: true,
  collection: 'adm_integrantes_organo',
  versionKey: false,
})
export class IntegranteOrgano {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ORGANOS_COPROPIEDAD })
  organo: OrganoCopropiedad;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Tercero', required: true })
  terceroId: Types.ObjectId;
}

export const IntegranteOrganoSchema =
  SchemaFactory.createForClass(IntegranteOrgano);

// A party sits once per body of a coproperty.
IntegranteOrganoSchema.index(
  { copropiedadId: 1, organo: 1, terceroId: 1 },
  { unique: true },
);
