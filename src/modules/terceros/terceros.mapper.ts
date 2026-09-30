// src/modules/terceros/terceros.mapper.ts
import type { Tercero as TerceroContract } from '../../contracts';
import type { TerceroDocument } from '../../database/schemas/terceros/tercero.schema';

/**
 * Maps a party document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md.
 */
export const toTercero = (doc: TerceroDocument): TerceroContract => ({
  id: doc._id.toString(),
  tipoPersona: doc.tipoPersona,
  nombre: doc.nombre,
  nom1: doc.primerNombre,
  nom2: doc.segundoNombre,
  ape1: doc.primerApellido,
  ape2: doc.segundoApellido,
  razonSocial: doc.razonSocial,
  tipoIdentificacion: doc.tipoIdentificacion,
  numeroIdentificacion: doc.numeroIdentificacion,
  digitoVerificacion: doc.digitoVerificacion,
  emails: doc.emails,
  telefono: doc.telefono,
  direccion: doc.direccion,
  ciudad: doc.ciudad,
  ciudadCodigo: doc.ciudadCodigo,
  ciudadDepartamentoCodigo: doc.ciudadDepartamentoCodigo,
  facturacionElectronica: {
    tipoIdentificacion: doc.tipoIdentificacionFe,
    numeroIdentificacion: doc.numeroIdentificacionFe,
    digitoVerificacion: doc.digitoVerificacionFe,
    codigoCiiu: doc.codigoCiiu,
    regimenVentas: doc.regimenVentas,
  },
  responsabilidadesFiscales: doc.responsabilidadesFiscales,
  retieneRenta: doc.retieneRenta,
  retieneIca: doc.retieneIca,
  estado: doc.estado === 'active' ? 'activo' : 'inactivo',
});
