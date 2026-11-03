// src/modules/integraciones-panel/integraciones-panel.mapper.ts
import type { Types } from 'mongoose';
import type { RegistroPanel } from '../../contracts';
import { normalizarId } from './id-registro';

/** The only fields of a Copropiedad the panel ever sees. */
export interface CopropiedadParaPanel {
  _id: Types.ObjectId;
  nombre: string;
  nit?: string | null;
  digitoVerificacion?: string | null;
  comptableEmpresaId?: string | null;
  websaco3CopropiedadId?: string | null;
}

/**
 * Maps a coproperty to the panel's `RegistroPanel`. A pure function that picks
 * fields one by one: the raw document (accounts, flags, settings) never leaves
 * this system through the panel.
 *
 * `nit` is `nit-dv` when the check digit is on file; no NIT means null, even
 * if a stray digit exists. Legacy documents lack the link keys and read as
 * unlinked.
 */
export function toRegistroPanel(doc: CopropiedadParaPanel): RegistroPanel {
  const vinculos: RegistroPanel['vinculos'] = [];
  if (doc.comptableEmpresaId) {
    vinculos.push({
      sistema: 'comptable',
      registroId: normalizarId(doc.comptableEmpresaId),
    });
  }
  if (doc.websaco3CopropiedadId) {
    vinculos.push({
      sistema: 'administracion',
      registroId: normalizarId(doc.websaco3CopropiedadId),
    });
  }

  return {
    id: doc._id.toString(),
    nombre: doc.nombre,
    nit: doc.nit
      ? doc.digitoVerificacion
        ? `${doc.nit}-${doc.digitoVerificacion}`
        : doc.nit
      : null,
    vinculos,
  };
}
