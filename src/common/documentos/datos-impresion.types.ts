import type { EmisorPlantillaFactura } from '../../contracts';

/**
 * Print-ready data shapes shared across every document type whose PDF is a
 * débito/crédito journal entry — Recibo, Nota de Crédito, Nota de Débito,
 * Nota Contable and Nota de Anticipo. Relocated from the now-deleted
 * `common/pdf/recibo-pdf.ts` react-pdf renderer (pdfmake + frontend-render
 * migration): the render function that used to consume these shapes is
 * gone, but the shapes themselves are still what each module's
 * `datosImpresion()`/`solicitar-generacion` response serializes for the
 * frontend to draw. Pure data — no framework imports — colocated here,
 * alongside `PresentacionDocumentoService`, because five unrelated modules
 * depend on it and none of them owns it.
 */

/** A block whose only job is to exist or not, pdfmake-template style — same
 *  "marker array" convention `FilaMarcadorFactura` documents in
 *  contracts/index.ts (`[]` false, `[{}]` true), reused here for the same
 *  WebSACO-logo-in-the-banner gate these five documents' template shares
 *  with Factura's own. */
export type FilaMarcadorImpresion = Record<string, never>;

/** One débito/crédito line of a document's own journal entry, already
 *  resolved to display-ready values (account code/name, target document
 *  type/number when the line settles one) — see each module's own
 *  `*-pdf-datos.util.ts` for how these are assembled from
 *  `AplicacionCartera`/`Factura`/`NotaDebito`/`CuentaContable`.
 *  `tipoDocumento`/`numeroDocumento` are both null for lines that don't
 *  settle one specific document (e.g. a bank line or a leftover-anticipo
 *  line). */
export interface LineaAsientoImpresion {
  cuentaCodigo: string;
  cuentaNombre: string;
  tipoDocumento: 'FV' | 'ND' | 'SI' | null;
  numeroDocumento: number | null;
  debito: number;
  credito: number;
}

/** Everything a Recibo/Nota Crédito/Nota Débito/Nota Contable/Nota Anticipo
 *  print needs, already resolved to display strings — despite the type's
 *  name, nothing here is Recibo-specific: a débito/crédito journal table, an
 *  amount, a date and an inmueble/titular/concepto block are exactly what
 *  every one of these five document types needs, and printing each any
 *  differently would defeat the point of sharing one layout. */
export interface DatosReciboImpresion {
  /** "Recibo de Caja" / "Nota de Crédito" / etc — printed before
   *  `numeroCompleto` in the header, right-aligned next to the NIT. */
  tituloDocumento: string;
  numeroCompleto: string;
  fecha: Date;
  inmuebleCodigo: string;
  titularNombre: string;
  /** "Por Concepto de" — the document's own `notes`, or a generic fallback
   *  when none was recorded. */
  concepto: string;
  monto: number;
  lineas: LineaAsientoImpresion[];
  /** Sum of `lineas[].debito`/`.credito` — the old react-pdf
   *  `contenidoRecibo` computed this inline with a `.reduce()` at render
   *  time; the pdfmake template has no arithmetic primitive, so it moves
   *  here, same "backend resolves, frontend only draws" split every other
   *  computed total in this codebase already follows. */
  totalDebito: number;
  totalCredito: number;
  /** The issuing coproperty's own header data — same
   *  `EmisorPlantillaFactura` shape Factura's own template uses, reused
   *  as-is (this shape was never actually Factura-specific, just named
   *  after its first caller). */
  emisor: EmisorPlantillaFactura;
  /** Same marker-array convention as `emisor.mostrarLogo` gating —
   *  `[]`/`[{}]` so the template's `$if` primitive can gate the banner
   *  logo the same way Factura's own template does. */
  logoFilas: FilaMarcadorImpresion[];
}
