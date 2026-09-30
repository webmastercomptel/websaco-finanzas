import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { EmisorPlantillaFactura } from '../../contracts';

/**
 * The issuing coproperty's own header data, exactly as a document's own
 * pdfmake template needs it — see `EmisorPlantillaFactura`'s own docblock
 * (contracts/index.ts) for why this is genuinely live and, for a Factura,
 * must be frozen via `printSnapshot` rather than re-derived from
 * `copropiedadId` on every read.
 *
 * Shared by `FacturasService` and the five document types that print
 * through `DatosReciboImpresion` (Recibo, Nota Crédito/Débito/Contable/
 * Anticipo) — extracted here (rather than kept private on
 * `FacturasService`) once a second, unrelated module needed the exact same
 * banner data.
 */
export function emisorDe(
  copropiedad: CopropiedadDocument,
): EmisorPlantillaFactura {
  const nitCompleto = copropiedad.nit
    ? `${copropiedad.nit}${copropiedad.digitoVerificacion ? `-${copropiedad.digitoVerificacion}` : ''}`
    : '—';
  const direccionCompleta =
    [copropiedad.direccion, copropiedad.ciudad].filter(Boolean).join(' - ') ||
    '—';
  return {
    nombre: copropiedad.nombre,
    nit: copropiedad.nit,
    digitoVerificacion: copropiedad.digitoVerificacion,
    direccion: copropiedad.direccion,
    ciudad: copropiedad.ciudad,
    telefono: copropiedad.telefono,
    email: copropiedad.email,
    mostrarLogo: copropiedad.mostrarLogo,
    nitCompleto,
    direccionCompleta,
    telefonoMostrado: copropiedad.telefono ?? '—',
    emailMostrado: copropiedad.email ?? '—',
  };
}
