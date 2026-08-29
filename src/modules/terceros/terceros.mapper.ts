// src/modules/terceros/terceros.mapper.ts
import type { Tercero as TerceroContract } from '../../contracts';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';

/**
 * Maps a party document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 */
export const toTercero = (doc: TerceroDocument): TerceroContract => ({
  id: doc._id.toString(),
  tipoPersona: doc.personType,
  nombre: doc.name,
  tipoIdentificacion: doc.identificationType,
  numeroIdentificacion: doc.identificationNumber,
  digitoVerificacion: doc.identificationVerificationDigit,
  email: doc.email,
  telefono: doc.phone,
  direccion: doc.address,
  ciudad: doc.city,
  facturacionElectronica: {
    tipoIdentificacion: doc.einvoiceIdentificationType,
    numeroIdentificacion: doc.einvoiceIdentificationNumber,
    digitoVerificacion: doc.einvoiceVerificationDigit,
    codigoCiiu: doc.ciiuCode,
    regimenVentas: doc.salesRegime,
  },
  responsabilidadesFiscales: doc.fiscalResponsibilities,
  retieneRenta: doc.withholdsIncomeTax,
  retieneIca: doc.withholdsLocalTax,
  estado: doc.status === 'active' ? 'activo' : 'inactivo',
});
