import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoPeso, formatoFecha } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { MarcaDuplicado } from './react/marca-duplicado';
import { CreditoWebsaco } from './react/credito-websaco';
import { Tabla } from './react/tabla';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/** One débito/crédito line of the Recibo's own journal entry, already
 *  resolved to display-ready values (account code/name, target document
 *  type/number when the line settles one) — see
 *  `construirDatosImpresionRecibo` (recibo-pdf-datos.util.ts) for how these
 *  are assembled from `AplicacionCartera`/`Factura`/`NotaDebito`/
 *  `CuentaContable`. `tipoDocumento`/`numeroDocumento` are both null for the
 *  bank line and the leftover-anticipo line — neither settles one specific
 *  document. */
export interface LineaAsientoImpresion {
  cuentaCodigo: string;
  cuentaNombre: string;
  tipoDocumento: 'FV' | 'ND' | null;
  numeroDocumento: number | null;
  debito: number;
  credito: number;
}

/** Everything this print needs, already resolved to display strings — the
 *  PDF renderer below does no database access and no business logic, it
 *  only draws. Shared by both a Recibo and a Nota Crédito print (see
 *  `tituloDocumento`) — despite the type's name, nothing else here is
 *  Recibo-specific: a débito/crédito journal table, an amount, a date and an
 *  inmueble/titular/concepto block are exactly what a Nota Crédito needs
 *  too, and printing it any differently would defeat the point of using the
 *  same layout. */
export interface DatosReciboImpresion {
  /** "Recibo de Caja" / "Nota de Crédito" — printed before `numeroCompleto`
   *  in the header, right-aligned next to the NIT. */
  tituloDocumento: string;
  numeroCompleto: string;
  fecha: Date;
  inmuebleCodigo: string;
  titularNombre: string;
  /** "Por Concepto de" — the document's own `notes` (see
   *  `redactarObservaciones` in `recibos.service.ts` for a Recibo, or the
   *  motivo label for a Nota Crédito with no notes of its own), or a
   *  generic fallback when none was recorded. */
  concepto: string;
  monto: number;
  lineas: LineaAsientoImpresion[];
}

/** Column widths for the journal-entry table, left to right: Codigo, Nombre
 *  del Cargo, Tipo, Numero, Valor Debito, Valor Credito — same relative
 *  proportions as the pdf-lib original's `ANCHOS_COLUMNA` (65/175/35/45/
 *  96/96, summing to the 512pt Letter-portrait content width). "Nombre del
 *  Cargo" gets the lion's share since account names run long ("CxC
 *  Intereses de Mora"); "Codigo"/"Tipo"/"Numero" are short, fixed
 *  identifiers. */
const ANCHOS_RELATIVOS = [65, 175, 35, 45, 96, 96];

const styles = StyleSheet.create({
  bloque: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  izquierda: {
    flexDirection: 'column',
  },
  fila: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  etiqueta: {
    width: 95,
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
  },
  valor: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
  },
  derecha: {
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  // Deliberately NOT dropped to the shared 8.5 with the rest of this
  // file's body text — a Recibo has no charges table to anchor on the way
  // Factura's own "Total a Pagar" band does, so the amount itself carries
  // the document's main emphasis instead.
  monto: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
  },
  fecha: {
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    marginTop: 8,
  },
});

/** Left column (inmueble / titular / concepto) alongside Valor and Fecha on
 *  the right, both right-aligned to the same edge — "Recibo No." isn't
 *  repeated here, the header already carries the document number. */
function BloqueRecibo(props: { datos: DatosReciboImpresion }): ReactElement {
  const { datos } = props;
  const filaDato = (etiqueta: string, valor: string): ReactElement =>
    createElement(
      View,
      { style: styles.fila },
      createElement(Text, { style: styles.etiqueta }, etiqueta),
      createElement(Text, { style: styles.valor }, valor),
    );

  return createElement(
    View,
    { style: styles.bloque },
    createElement(
      View,
      { style: styles.izquierda },
      filaDato('Inmueble :', datos.inmuebleCodigo),
      filaDato('Nombre :', datos.titularNombre),
      filaDato('Por Concepto de', datos.concepto),
    ),
    createElement(
      View,
      { style: styles.derecha },
      createElement(Text, { style: styles.monto }, formatoPeso(datos.monto)),
      createElement(
        Text,
        { style: styles.fecha },
        `Fecha : ${formatoFecha(datos.fecha.toISOString())}`,
      ),
    ),
  );
}

/**
 * Generates a real PDF for a Recibo (cash receipt) or a Nota Crédito
 * (`datos.tituloDocumento` picks which), styled after the predecessor
 * system's own printed layout: a gray banner with the copropiedad name, the
 * document number top-right, a two-column info block (inmueble/titular/
 * concepto on the left, the amount and date on the right), and the actual
 * journal entry as a débito/crédito table — not a generic "aplicaciones"
 * list, since what a resident wants to see on either document is exactly
 * what the old system showed: which account absorbed the money, against
 * which document. React-pdf, built directly (no pdf-lib version kept
 * behind a `?version=` toggle).
 */
export async function generarPdfRecibo(
  datos: DatosReciboImpresion,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Buffer> {
  return renderizarPdf(
    reporteDocumento(contenidoRecibo(datos, copropiedad, opciones)),
  );
}

/** Page content only, no `<Document>`/`<Page>` wrapper — shared with
 *  `generarPdfRecibosLote`, same split as `contenidoDocumentoFacturacion`/
 *  `paginaFactura` in `factura-pdf.ts`. */
export function contenidoRecibo(
  datos: DatosReciboImpresion,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): ReactElement {
  const totalDebito = datos.lineas.reduce((acc, l) => acc + l.debito, 0);
  const totalCredito = datos.lineas.reduce((acc, l) => acc + l.credito, 0);

  return createElement(
    View,
    null,
    opciones?.duplicado
      ? createElement(MarcaDuplicado, {
          fechaEmisionIso: datos.fecha.toISOString(),
        })
      : null,
    createElement(EncabezadoDocumento, {
      copropiedad,
      titulo: `${datos.tituloDocumento} ${datos.numeroCompleto}`,
    }),
    createElement(BloqueRecibo, { datos }),
    createElement(Tabla, {
      columnas: [
        'Codigo',
        'Nombre del Cargo',
        'Tipo',
        'Numero',
        'Valor Debito',
        'Valor Credito',
      ],
      filas: datos.lineas.map((l) => [
        l.cuentaCodigo,
        l.cuentaNombre,
        l.tipoDocumento ?? '',
        l.numeroDocumento !== null ? String(l.numeroDocumento) : '',
        l.debito > 0 ? formatoPeso(l.debito) : '0.00',
        l.credito > 0 ? formatoPeso(l.credito) : '0.00',
      ]),
      columnasNumericas: 2,
      anchosRelativos: ANCHOS_RELATIVOS,
      striped: true,
      // Matches Factura's own body size — see the sibling font-size pass
      // across this file and the other vertical (portrait) PDFs.
      fontSize: 8.5,
      filaTotales: [
        'Totales',
        '',
        '',
        '',
        formatoPeso(totalDebito),
        formatoPeso(totalCredito),
      ],
    }),
    createElement(CreditoWebsaco),
  );
}
