import { rgb } from 'pdf-lib';
import {
  crearContexto,
  embebirLogoWebsaco,
  escribirMarcaDuplicado,
  formatoPeso,
  formatoFecha,
  type PdfContext,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const MARGIN_LEFT = 50;
const GRIS_CLARO = rgb(0.9, 0.9, 0.9);

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

/**
 * Generates a real PDF for a Recibo (cash receipt) or a Nota Crédito
 * (`datos.tituloDocumento` picks which), styled after the predecessor
 * system's own printed layout: a gray banner with the copropiedad name, the
 * document number top-right, a two-column info block (inmueble/titular/
 * concepto on the left, the amount and date on the right), and the actual
 * journal entry as a débito/crédito table — not a generic "aplicaciones"
 * list, since what a resident wants to see on either document is exactly
 * what the old system showed: which account absorbed the money, against
 * which document.
 */
export async function generarPdfRecibo(
  datos: DatosReciboImpresion,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  await dibujarEncabezadoRecibo(
    ctx,
    copropiedad,
    datos.tituloDocumento,
    datos.numeroCompleto,
  );
  dibujarBloqueRecibo(ctx, datos);
  dibujarTablaAsiento(ctx, datos.lineas);

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, datos.fecha.toISOString());
  }

  return ctx.doc.save();
}

/** First two header lines mirror `dibujarEncabezadoFactura` (factura-pdf.ts)
 *  exactly — same gray banner with the copropiedad name and logo, same
 *  NIT row with the document title right-aligned beside it, same thin gray
 *  rule ("rayita") below — so a Recibo/Nota de Crédito prints with the
 *  identical masthead as a Factura instead of its own heavier banner. */
async function dibujarEncabezadoRecibo(
  ctx: PdfContext,
  copropiedad: CopropiedadDocument,
  tituloDocumento: string,
  numeroCompleto: string,
): Promise<void> {
  const bannerAltura = 26;
  const bannerTop = ctx.y + 8;
  const bannerBottom = bannerTop - bannerAltura;
  ctx.page.drawRectangle({
    x: 0,
    y: ctx.y - bannerAltura + 8,
    width: ctx.pageWidth,
    height: bannerAltura,
    color: GRIS_CLARO,
  });
  ctx.page.drawText(copropiedad.name, {
    x: MARGIN_LEFT,
    y: ctx.y - 10,
    size: 16,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const {
    image: logo,
    width: logoWidth,
    height: logoHeight,
  } = await embebirLogoWebsaco(ctx.doc);
  ctx.page.drawImage(logo, {
    x: MARGIN_LEFT + ctx.contentWidth - logoWidth,
    y: (bannerTop + bannerBottom) / 2 - logoHeight / 2,
    width: logoWidth,
    height: logoHeight,
  });

  ctx.y -= bannerAltura + 6;

  const filaTitulo = ctx.y;
  const nit = copropiedad.taxId
    ? copropiedad.taxIdVerificationDigit
      ? `${copropiedad.taxId}-${copropiedad.taxIdVerificationDigit}`
      : copropiedad.taxId
    : '—';
  ctx.page.drawText('NIT :', {
    x: MARGIN_LEFT,
    y: filaTitulo,
    size: 9,
    font: ctx.font,
    color: rgb(0.3, 0.3, 0.3),
  });
  ctx.page.drawText(nit, {
    x: MARGIN_LEFT + 35,
    y: filaTitulo,
    size: 9,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });

  const titulo = `${tituloDocumento} ${numeroCompleto}`;
  const tituloAncho = ctx.fontBold.widthOfTextAtSize(titulo, 13);
  ctx.page.drawText(titulo, {
    x: MARGIN_LEFT + ctx.contentWidth - tituloAncho,
    y: filaTitulo,
    size: 13,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  ctx.y -= 10;
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y },
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  ctx.y -= 14;
}

/** Left column (inmueble / titular / concepto) alongside "Recibo No.",
 *  Valor and Fecha on the right — all three right-aligned to the same edge,
 *  the same convention the asiento table's own "Valor Credito" column uses.
 *  The amount keeps its large size (the predecessor's own visual anchor for
 *  this document), Recibo No./Fecha sit above/below it in the same column. */
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

  // ── Recibo No. / Valor / Fecha, all right-aligned to the same edge ──
  const reciboNoTexto = `Recibo No. ${datos.numeroCompleto}`;
  const reciboNoAncho = ctx.font.widthOfTextAtSize(reciboNoTexto, 10);
  ctx.page.drawText(reciboNoTexto, {
    x: MARGIN_LEFT + ctx.contentWidth - reciboNoAncho,
    y: inicioBloque,
    size: 10,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });

  const montoTexto = formatoPeso(datos.monto);
  const montoSize = 24;
  const montoAncho = ctx.fontBold.widthOfTextAtSize(montoTexto, montoSize);
  ctx.page.drawText('$', {
    x: MARGIN_LEFT + ctx.contentWidth - montoAncho - 22,
    y: inicioBloque - 16,
    size: 16,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.page.drawText(montoTexto.replace(/^\$\s?/, ''), {
    x: MARGIN_LEFT + ctx.contentWidth - montoAncho,
    y: inicioBloque - 20,
    size: montoSize,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const fechaTexto = formatoFecha(datos.fecha);
  const filaFecha = `Fecha : ${fechaTexto}`;
  const filaFechaAncho = ctx.font.widthOfTextAtSize(filaFecha, 10);
  ctx.page.drawText(filaFecha, {
    x: MARGIN_LEFT + ctx.contentWidth - filaFechaAncho,
    y: inicioBloque - 48,
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

  // Totales bajado una línea respecto a la última fila de datos, para que no
  // quede pegado — un renglón de aire entre el asiento y su total.
  ctx.y -= 15;

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
