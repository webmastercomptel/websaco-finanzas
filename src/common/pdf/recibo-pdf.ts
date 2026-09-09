import { rgb } from 'pdf-lib';
import {
  crearContexto,
  escribirMarcaDuplicado,
  formatoPeso,
  formatoFecha,
  type PdfContext,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const MARGIN_LEFT = 50;
const GRIS_CLARO = rgb(0.9, 0.9, 0.9);
const AZUL_NOTA = rgb(0.3, 0.4, 0.6);

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

/** Everything the Recibo print needs, already resolved to display strings —
 *  the PDF renderer below does no database access and no business logic, it
 *  only draws. */
export interface DatosReciboImpresion {
  numeroCompleto: string;
  fecha: Date;
  inmuebleCodigo: string;
  titularNombre: string;
  /** "Por Concepto de" — the Recibo's own `notes` (see
   *  `redactarObservaciones` in `recibos.service.ts`), or a generic fallback
   *  when none was recorded. */
  concepto: string;
  monto: number;
  lineas: LineaAsientoImpresion[];
}

/**
 * Generates a real PDF for a Recibo (cash receipt), styled after the
 * predecessor system's own printed layout: a gray banner with the
 * copropiedad name, the receipt number top-right, a two-column info block
 * (inmueble/titular/concepto on the left, the amount and date on the right),
 * and the actual journal entry as a débito/crédito table — not a generic
 * "aplicaciones" list, since what a resident wants to see on a receipt is
 * exactly what the old system showed: which account absorbed the money,
 * against which document.
 */
export async function generarPdfRecibo(
  datos: DatosReciboImpresion,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  dibujarEncabezadoRecibo(ctx, copropiedad, datos.numeroCompleto);
  dibujarBloqueRecibo(ctx, datos);
  dibujarTablaAsiento(ctx, datos.lineas);

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, datos.fecha.toISOString());
  }

  return ctx.doc.save();
}

/** Gray banner with the copropiedad name, NIT below it, and "Recibo de Caja
 *  {numeroCompleto}" bold and right-aligned on the same row as the NIT —
 *  mirrors the predecessor system's own header exactly. */
function dibujarEncabezadoRecibo(
  ctx: PdfContext,
  copropiedad: CopropiedadDocument,
  numeroCompleto: string,
): void {
  const bannerAltura = 34;
  ctx.page.drawRectangle({
    x: 0,
    y: ctx.y - bannerAltura + 10,
    width: ctx.pageWidth,
    height: bannerAltura,
    color: GRIS_CLARO,
  });
  ctx.page.drawText(copropiedad.name, {
    x: MARGIN_LEFT,
    y: ctx.y - 12,
    size: 20,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.y -= bannerAltura + 14;

  const filaTitulo = ctx.y;
  const nit = copropiedad.taxId
    ? copropiedad.taxIdVerificationDigit
      ? `${copropiedad.taxId}-${copropiedad.taxIdVerificationDigit}`
      : copropiedad.taxId
    : '—';
  ctx.page.drawText('NIT :', {
    x: MARGIN_LEFT,
    y: filaTitulo,
    size: 10,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });
  ctx.page.drawText(nit, {
    x: MARGIN_LEFT + 35,
    y: filaTitulo,
    size: 10,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });

  const titulo = `Recibo de Caja ${numeroCompleto}`;
  const tituloAncho = ctx.fontBold.widthOfTextAtSize(titulo, 16);
  ctx.page.drawText(titulo, {
    x: MARGIN_LEFT + ctx.contentWidth - tituloAncho,
    y: filaTitulo,
    size: 16,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  ctx.y -= 22;
  ctx.page.drawRectangle({
    x: 0,
    y: ctx.y,
    width: ctx.pageWidth,
    height: 5,
    color: GRIS_CLARO,
  });
  ctx.y -= 20;
}

/** Left column (inmueble / titular / concepto) alongside the amount and
 *  date on the right — the predecessor's own two-column layout, so the
 *  amount reads as the visual anchor of the page, same as the original. */
function dibujarBloqueRecibo(
  ctx: PdfContext,
  datos: DatosReciboImpresion,
): void {
  const inicioBloque = ctx.y;
  const filas: [string, string][] = [
    ['Inmueble :', datos.inmuebleCodigo],
    ['Nombre :', datos.titularNombre],
    ['Por Concepto de', datos.concepto],
  ];
  for (const [label, valor] of filas) {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: 10,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
    ctx.page.drawText(valor, {
      x: MARGIN_LEFT + 95,
      y: ctx.y,
      size: 10,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.y -= 15;
  }

  // ── Amount + date, right-aligned, anchored to the block's top row ──
  const montoTexto = formatoPeso(datos.monto);
  const montoSize = 24;
  const montoAncho = ctx.fontBold.widthOfTextAtSize(montoTexto, montoSize);
  ctx.page.drawText('$', {
    x: MARGIN_LEFT + ctx.contentWidth - montoAncho - 22,
    y: inicioBloque - 2,
    size: 16,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.page.drawText(montoTexto.replace(/^\$\s?/, ''), {
    x: MARGIN_LEFT + ctx.contentWidth - montoAncho,
    y: inicioBloque - 6,
    size: montoSize,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const fechaY = inicioBloque - 34;
  const etiquetaFecha = '(dd/mm/aaaa)';
  const etiquetaAncho = ctx.font.widthOfTextAtSize(etiquetaFecha, 7);
  ctx.page.drawText(etiquetaFecha, {
    x: MARGIN_LEFT + ctx.contentWidth - etiquetaAncho,
    y: fechaY,
    size: 7,
    font: ctx.font,
    color: AZUL_NOTA,
  });

  const fechaTexto = formatoFecha(datos.fecha);
  const filaFecha = `Fecha    ${fechaTexto}`;
  const filaFechaAncho = ctx.font.widthOfTextAtSize(filaFecha, 10);
  ctx.page.drawText(filaFecha, {
    x: MARGIN_LEFT + ctx.contentWidth - filaFechaAncho,
    y: fechaY - 14,
    size: 10,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });

  ctx.y -= 20;
}

/** Column widths for the journal-entry table, left to right: Codigo,
 *  Nombre del Cargo, Tipo, Numero, Valor Debito, Valor Credito — summing to
 *  exactly `ctx.contentWidth` (512pt on Letter portrait). "Nombre del
 *  Cargo" gets the lion's share since account names run long
 *  ("CxC Intereses de Mora"); "Codigo"/"Tipo"/"Numero" are short, fixed
 *  identifiers. Not `escribirTabla` (equal-width columns) — this table's
 *  columns need very different widths to read cleanly. */
const ANCHOS_COLUMNA = {
  codigo: 65,
  nombreCargo: 175,
  tipo: 35,
  numero: 45,
  debito: 96,
  credito: 96,
};

/** The journal-entry table itself, plus the bold, gray-shaded "Totales"
 *  row — mirrors the predecessor system's own printed layout line for
 *  line. */
function dibujarTablaAsiento(
  ctx: PdfContext,
  lineas: LineaAsientoImpresion[],
): void {
  const columnas = [
    { titulo: 'Codigo', ancho: ANCHOS_COLUMNA.codigo, numerica: false },
    {
      titulo: 'Nombre del Cargo',
      ancho: ANCHOS_COLUMNA.nombreCargo,
      numerica: false,
    },
    { titulo: 'Tipo', ancho: ANCHOS_COLUMNA.tipo, numerica: false },
    { titulo: 'Numero', ancho: ANCHOS_COLUMNA.numero, numerica: false },
    { titulo: 'Valor Debito', ancho: ANCHOS_COLUMNA.debito, numerica: true },
    { titulo: 'Valor Credito', ancho: ANCHOS_COLUMNA.credito, numerica: true },
  ];

  dibujarFilaTabla(
    ctx,
    columnas.map((c) => ({ texto: c.titulo, numerica: c.numerica })),
    columnas.map((c) => c.ancho),
    { bold: true },
  );
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 5 },
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y + 5 },
    thickness: 0.75,
    color: rgb(0, 0, 0),
  });
  ctx.y -= 6;

  for (const linea of lineas) {
    if (ctx.y < 90) {
      ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
      ctx.y = ctx.pageHeight - 50;
    }
    dibujarFilaTabla(
      ctx,
      [
        { texto: linea.cuentaCodigo, numerica: false },
        { texto: linea.cuentaNombre, numerica: false },
        { texto: linea.tipoDocumento ?? '', numerica: false },
        {
          texto:
            linea.numeroDocumento !== null ? String(linea.numeroDocumento) : '',
          numerica: false,
        },
        {
          texto: linea.debito > 0 ? formatoPeso(linea.debito) : '0.00',
          numerica: true,
        },
        {
          texto: linea.credito > 0 ? formatoPeso(linea.credito) : '0.00',
          numerica: true,
        },
      ],
      columnas.map((c) => c.ancho),
    );
  }

  const totalDebito = lineas.reduce((acc, l) => acc + l.debito, 0);
  const totalCredito = lineas.reduce((acc, l) => acc + l.credito, 0);

  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: ctx.y - 4,
    width: ctx.contentWidth,
    height: 16,
    color: GRIS_CLARO,
  });
  dibujarFilaTabla(
    ctx,
    [
      { texto: 'Totales', numerica: false },
      { texto: '', numerica: false },
      { texto: '', numerica: false },
      { texto: '', numerica: false },
      { texto: formatoPeso(totalDebito), numerica: true },
      { texto: formatoPeso(totalCredito), numerica: true },
    ],
    columnas.map((c) => c.ancho),
    { bold: true },
  );
}

/** Draws one row of fixed-width cells, left-aligned for text columns and
 *  right-aligned (with a small right padding) for numeric ones, advancing
 *  `ctx.y` by one line afterward. Shared by the table's header, its data
 *  rows, and its Totales row so all three stay pixel-aligned to the same
 *  column edges. */
function dibujarFilaTabla(
  ctx: PdfContext,
  celdas: { texto: string; numerica: boolean }[],
  anchos: number[],
  opciones?: { bold?: boolean },
): void {
  const font = opciones?.bold ? ctx.fontBold : ctx.font;
  const size = 9;
  let x = MARGIN_LEFT;
  celdas.forEach((celda, i) => {
    const ancho = anchos[i];
    if (celda.texto) {
      const textWidth = font.widthOfTextAtSize(celda.texto, size);
      const cellX = celda.numerica ? x + ancho - textWidth - 6 : x + 4;
      ctx.page.drawText(celda.texto, {
        x: cellX,
        y: ctx.y,
        size,
        font,
        color: rgb(0, 0, 0),
      });
    }
    x += ancho;
  });
  ctx.y -= 15;
}
