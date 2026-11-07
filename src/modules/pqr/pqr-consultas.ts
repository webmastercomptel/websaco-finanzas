import { Types, type PopulateOptions } from 'mongoose';

/**
 * Filter of ONE PQR of the active coproperty. `soloDe` narrows it to the PQRs a
 * resident filed, so "not yours" and "does not exist" are indistinguishable (a
 * 404, never a 403 that confirms the id is real). Never `findById`: the id alone
 * says nothing about the tenant.
 */
export const filtroPqr = (
  id: string | Types.ObjectId,
  copropiedadId: Types.ObjectId,
  soloDe?: Types.ObjectId,
): Record<string, unknown> => ({
  _id: id,
  copropiedadId,
  ...(soloDe && { autorId: soloDe }),
});

/**
 * Populates the assigned technician's name for `tecnicoAsignado`. The `match`
 * keeps the lookup inside the tenant as well: a technician of another building
 * can never leak its name through a stale reference (it populates as null).
 */
export const poblarTecnico = (
  copropiedadId: Types.ObjectId,
): PopulateOptions => ({
  path: 'tecnicoId',
  select: 'nombre',
  match: { copropiedadId },
});
