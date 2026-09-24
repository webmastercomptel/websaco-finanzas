import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { EmisorPlantillaFactura } from '../../contracts';

/**
 * The issuing coproperty's own header data, exactly as a document's own
 * pdfmake template needs it — see `EmisorPlantillaFactura`'s own docblock
 * (contracts/index.ts) for why this is genuinely live and, for a Factura,
 * must be frozen via `printSnapshot` rather than re-derived from
 * `coPropertyId` on every read.
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
  const nitCompleto = copropiedad.taxId
    ? `${copropiedad.taxId}${copropiedad.taxIdVerificationDigit ? `-${copropiedad.taxIdVerificationDigit}` : ''}`
    : '—';
  const direccionCompleta =
    [copropiedad.address, copropiedad.city].filter(Boolean).join(' - ') || '—';
  return {
    nombre: copropiedad.name,
    nit: copropiedad.taxId,
    digitoVerificacion: copropiedad.taxIdVerificationDigit,
    direccion: copropiedad.address,
    ciudad: copropiedad.city,
    telefono: copropiedad.phone,
    email: copropiedad.email,
    mostrarLogo: copropiedad.showLogoOnDocuments,
    nitCompleto,
    direccionCompleta,
    telefonoMostrado: copropiedad.phone ?? '—',
    emailMostrado: copropiedad.email ?? '—',
  };
}
