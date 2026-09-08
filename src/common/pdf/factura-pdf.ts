import { rgb, type PDFFont } from 'pdf-lib';
import {
  crearContexto,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  embebirLogoWebsaco,
  formatoPeso,
  formatoFecha,
  type PdfContext,
} from './pdf-helpers';
import type {
  FacturaLinea,
  TitularCongelado,
} from '../../database/schemas/facturacion/factura-linea.schema';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const MARGIN_LEFT = 50;
const GRIS_CLARO = rgb(0.9, 0.9, 0.9);
const ROJO_DESCUENTO = rgb(0.75, 0, 0);

/**
 * What the shared renderer needs, independent of whether it came from an
 * already-numbered Factura or a still-editable FacturaPreliminar — the two
 * are visually identical documents (per product decision), so this is the
 * only shape either builder has to produce.
 */
export interface DatosDocumentoFacturacion {
  titulo: string;
  unitCode: string;
  holder: TitularCongelado | null;
  issueDate: Date;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  lines: FacturaLinea[];
  descuento: InfoDescuentoProntoPago | null;
}

export interface InfoDescuentoProntoPago {
  fechaLimite: Date;
  monto: number;
}

/**
 * Computes the early-payment discount offer for one invoice/preliminar, from
 * the lote's own `earlyPaymentDiscount` (%, "Descuento Pronto Pago" on the
 * Lote screen) and `discountDeadline` ("Fecha límite para descuento") —
 * neither of which had ever been READ anywhere before this (see both
 * fields' own schema comments). Applied to the Administración line's own
 * `baseAmount` — same target as the mora calculation, "el saldo anterior
 * que tenga el cargo de administración" (confirmed with product for mora;
 * mirrored here) — never to the whole invoice, which would mix in
 * multas/otros ingresos the discount was never meant to touch.
 *
 * Returns null (no red note on the page) when there is nothing to offer:
 * no discount percentage configured on this lote, no Administración line on
 * this document, the computed amount rounds to 0, or — the explicit
 * business rule — this cycle already charged mora. Paying late once
 * forfeits that cycle's early-payment offer; it does not retroactively
 * change what mora already computed.
 */
export function calcularDescuentoProntoPago(
  lines: FacturaLinea[],
  earlyPaymentDiscount: number,
  discountDeadline: Date,
): InfoDescuentoProntoPago | null {
  if (!(earlyPaymentDiscount > 0)) return null;

  const tieneMora = lines.some(
    (l) => l.conceptKind === 'intereses' && l.totalAmount > 0,
  );
  if (tieneMora) return null;

  const administracion = lines.find((l) => l.conceptKind === 'administracion');
  if (!administracion) return null;

  const monto = Math.round(
    administracion.baseAmount * (earlyPaymentDiscount / 100),
  );
  if (monto <= 0) return null;

  return { fechaLimite: discountDeadline, monto };
}

/**
 * Renders the "Consulta/Listado de Facturación"-style invoice layout the
 * predecessor system used — a per-concept "Saldo Anterior / Cargos del Mes
 * / Nuevo Saldo" table, not a generic line-item invoice — so the resident
 * sees both what this document charges AND their running balance per
 * concept, exactly like the WebSaco original. Shared by `generarPdfFactura`
 * and `generarPdfPrefactura`; the only difference between the two is the
 * `titulo` (and that a Factura's `lines[].balanceBefore/After` are frozen
 * at consolidación while a preliminar's are computed live). Returns the
 * still-open `PdfContext` rather than saved bytes — `generarPdfFactura`
 * still has its own DIAN footer and duplicado stamp to add on top before
 * saving; `generarPdfPrefactura` saves it as-is.
 */
export async function generarContextoDocumentoFacturacion(
  datos: DatosDocumentoFacturacion,
  copropiedad: CopropiedadDocument,
): Promise<PdfContext> {
  const ctx = await crearContexto();

  await dibujarEncabezadoFactura(ctx, copropiedad, datos.titulo);
  dibujarBloqueInmueble(ctx, datos);
  dibujarTablaConceptos(ctx, datos.lines);
  dibujarSubtotal(ctx, datos.lines);
  dibujarTotalAPagar(ctx, datos.lines);

  // Bordered box the predecessor left blank for a handwritten note/signature
  // — now also carries the coproperty's own "Observaciones de facturación"
  // (Parámetros de Facturación), centered, when there is one.
  ctx.y -= 10;
  const cajaAltura = 60;
  const cajaAnchoObs = ctx.contentWidth * 0.6;
  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: ctx.y - cajaAltura,
    width: cajaAnchoObs,
    height: cajaAltura,
    borderColor: rgb(0.7, 0.7, 0.7),
    borderWidth: 1,
  });
  dibujarObservacionesCentradas(
    ctx,
    copropiedad.billingNotes,
    cajaAnchoObs,
    cajaAltura,
  );
  dibujarDescuentoProntoPago(
    ctx,
    datos.descuento,
    datos.lines,
    cajaAnchoObs,
    cajaAltura,
  );
  ctx.y -= cajaAltura + 10;

  return ctx;
}

/** Gray banner with the copropiedad name, contact block, and the document
 *  title (right-aligned) — the header every printed page of this document
 *  type shares. The WebSACO logo sits inside the same banner, right of the
 *  copropiedad name — same size as Estado de Cuenta's (see LOGO_WIDTH in
 *  pdf-helpers.ts). */
async function dibujarEncabezadoFactura(
  ctx: PdfContext,
  copropiedad: CopropiedadDocument,
  titulo: string,
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

  const filaSuperior = ctx.y;
  const contacto: [string, string | null][] = [
    [
      'NIT :',
      copropiedad.taxId
        ? copropiedad.taxIdVerificationDigit
          ? `${copropiedad.taxId}-${copropiedad.taxIdVerificationDigit}`
          : copropiedad.taxId
        : null,
    ],
    ['Dirección :', copropiedad.address],
    ['Celular :', copropiedad.phone],
    ['Email :', copropiedad.email],
  ];
  for (const [label, valor] of contacto) {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: 9,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
    ctx.page.drawText(valor ?? '', {
      x: MARGIN_LEFT + 70,
      y: ctx.y,
      size: 9,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.y -= 13;
  }

  const tituloAncho = ctx.fontBold.widthOfTextAtSize(titulo, 13);
  ctx.page.drawText(titulo, {
    x: MARGIN_LEFT + ctx.contentWidth - tituloAncho,
    y: filaSuperior,
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

/** Left column (unit + titular) alongside the bordered "Fecha/Periodo" box
 *  on the right — the predecessor's "ID: {código}" sits on the same row as
 *  "Codigo del Inmueble". */
function dibujarBloqueInmueble(
  ctx: PdfContext,
  datos: DatosDocumentoFacturacion,
): void {
  const inicioBloque = ctx.y;
  const h = datos.holder;
  const identificacion = h
    ? [h.identificationType, h.identificationNumber].filter(Boolean).join(' ')
    : '';

  const filas: [string, string][] = [
    ['Codigo del Inmueble :', datos.unitCode],
    ['Nombre :', h?.name ?? ''],
    ['Direccion :', h?.address ?? ''],
    ['Email :', h?.email ?? ''],
    ['Identificación :', identificacion],
  ];
  for (const [label, valor] of filas) {
    ctx.page.drawText(label, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: 9,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
    ctx.page.drawText(valor, {
      x: MARGIN_LEFT + 100,
      y: ctx.y,
      size: 9,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    ctx.y -= 13;
  }
  ctx.page.drawText(`ID: ${datos.unitCode}`, {
    x: MARGIN_LEFT + 220,
    y: inicioBloque,
    size: 9,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  // ── Bordered date/period box, right-aligned ──
  const cajaAncho = 170;
  const cajaX = MARGIN_LEFT + ctx.contentWidth - cajaAncho;
  const cajaAlto = 82;
  const cajaYtope = inicioBloque + 4;
  ctx.page.drawRectangle({
    x: cajaX,
    y: cajaYtope - cajaAlto,
    width: cajaAncho,
    height: cajaAlto,
    borderColor: rgb(0.6, 0.6, 0.6),
    borderWidth: 0.75,
  });

  let yCaja = cajaYtope - 12;
  ctx.page.drawText('(dd/mm/aaaa)', {
    x: cajaX + 10,
    y: yCaja,
    size: 7,
    font: ctx.font,
    color: rgb(0.4, 0.4, 0.4),
  });
  yCaja -= 14;
  const filaCaja = (label: string, valor: string): void => {
    ctx.page.drawText(label, {
      x: cajaX + 10,
      y: yCaja,
      size: 9,
      font: ctx.font,
      color: rgb(0.3, 0.3, 0.3),
    });
    ctx.page.drawText(valor, {
      x: cajaX + 55,
      y: yCaja,
      size: 9,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
    yCaja -= 13;
  };
  filaCaja('Fecha :', formatoFecha(datos.issueDate));
  filaCaja('Vence :', formatoFecha(datos.dueDate));
  yCaja -= 4;
  ctx.page.drawText('Periodo', {
    x: cajaX + 10,
    y: yCaja,
    size: 8,
    font: ctx.font,
    color: rgb(0.4, 0.4, 0.4),
  });
  yCaja -= 13;
  filaCaja('Desde :', formatoFecha(datos.periodStart));
  filaCaja('Hasta :', formatoFecha(datos.periodEnd));

  // The next element (the concept table) must clear whichever column runs
  // LOWER on the page — the left column (`ctx.y`, five 13pt rows) or this
  // box (`cajaAlto` 82pt, taller than the five rows). Advancing by only the
  // left column's own height, as this used to, left the box's bottom ~3pt
  // BELOW where the table then started drawing — the table's own header
  // collided with "Periodo/Hasta" here, "montados" on top of each other.
  const cajaBottom = cajaYtope - cajaAlto;
  ctx.y = Math.min(ctx.y, cajaBottom) - 10;
}

/** Greedy word-wrap: splits `texto` into lines no wider than `maxWidth` at
 *  `size`. Good enough for a short note — this box was never meant to hold
 *  a paragraph. */
function envolverTexto(
  font: PDFFont,
  texto: string,
  size: number,
  maxWidth: number,
): string[] {
  const palabras = texto.split(/\s+/).filter(Boolean);
  const lineas: string[] = [];
  let actual = '';
  for (const palabra of palabras) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (actual && font.widthOfTextAtSize(prueba, size) > maxWidth) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = prueba;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

/** Centers `observaciones` (Copropiedad.billingNotes) inside the box
 *  `dibujarObservacionesCentradas`'s caller just drew — both horizontally
 *  (each line) and vertically (the whole block within the box). Draws
 *  nothing when there is no note (the box stays exactly as blank as before
 *  this feature). Lines beyond what the box can hold are dropped rather
 *  than overflowing its border — a coproperty with a long note should
 *  shorten it, not have this box bleed into the next page element. */
function dibujarObservacionesCentradas(
  ctx: PdfContext,
  observaciones: string | null,
  cajaAncho: number,
  cajaAltura: number,
): void {
  const texto = observaciones?.trim();
  if (!texto) return;

  const size = 9;
  const lineHeight = 12;
  const padding = 10;
  const maxLineas = Math.max(
    1,
    Math.floor((cajaAltura - padding) / lineHeight),
  );
  const lineas = envolverTexto(
    ctx.font,
    texto,
    size,
    cajaAncho - padding * 2,
  ).slice(0, maxLineas);

  const bloqueAltura = lineas.length * lineHeight;
  let y = ctx.y - (cajaAltura - bloqueAltura) / 2 - lineHeight * 0.8;
  for (const linea of lineas) {
    const anchoLinea = ctx.font.widthOfTextAtSize(linea, size);
    ctx.page.drawText(linea, {
      x: MARGIN_LEFT + (cajaAncho - anchoLinea) / 2,
      y,
      size,
      font: ctx.font,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= lineHeight;
  }
}

/** Red, centered promo note in the space to the RIGHT of the observaciones
 *  box (the remaining 40% of `contentWidth`, same row) — "Si cancela antes
 *  del {fecha límite}" / "Cancele $: {total a pagar - descuento}". Draws
 *  nothing when `descuento` is null (see `calcularDescuentoProntoPago` for
 *  every reason that can be — no % configured, no Administración line, the
 *  rounded amount is 0, or this cycle already carries mora). */
function dibujarDescuentoProntoPago(
  ctx: PdfContext,
  descuento: InfoDescuentoProntoPago | null,
  lines: FacturaLinea[],
  cajaAnchoObs: number,
  cajaAltura: number,
): void {
  if (!descuento) return;

  const totalAPagar = lines.reduce((acc, l) => acc + l.balanceAfter, 0);
  const cancele = totalAPagar - descuento.monto;

  const areaX = MARGIN_LEFT + cajaAnchoObs;
  const areaAncho = MARGIN_LEFT + ctx.contentWidth - areaX;
  const size = 9;
  const lineHeight = 12;
  const lineas = [
    `Si cancela antes del ${formatoFecha(descuento.fechaLimite)}`,
    `Cancele $: ${cancele.toLocaleString('es-CO')}`,
  ];

  const bloqueAltura = lineas.length * lineHeight;
  let y = ctx.y - (cajaAltura - bloqueAltura) / 2 - lineHeight * 0.8;
  for (const linea of lineas) {
    const anchoLinea = ctx.fontBold.widthOfTextAtSize(linea, size);
    ctx.page.drawText(linea, {
      x: areaX + (areaAncho - anchoLinea) / 2,
      y,
      size,
      font: ctx.fontBold,
      color: ROJO_DESCUENTO,
    });
    y -= lineHeight;
  }
}

/** "Nombre del Cargo / Saldo Anterior / Cargos del Mes / Nuevo Saldo" —
 *  the per-concept running-balance table. No "Totales" row here anymore —
 *  `dibujarSubtotal` draws that same total, aligned to these same four
 *  columns, right below the table (labeled "Subtotal" and always shown,
 *  not just a table footer) so it reads as one continuous summary with the
 *  IVA/Total a Pagar lines that follow it, instead of two separate totals
 *  rows on the page.
 *
 *  "Cargos del Mes" shows each line's `baseAmount`, NOT `totalAmount` — when
 *  a cargo carries IVA, the tax portion is broken out separately by
 *  `dibujarSubtotal` right below this table, so showing it again here would
 *  double it visually. "Nuevo Saldo" is `balanceBefore + baseAmount`, NOT
 *  the frozen `balanceAfter` — same reasoning: the tax this cargo added to
 *  real cartera is real and stays in `balanceAfter` for the NEXT invoice's
 *  own "Saldo Anterior", but showing it again here, on top of the separate
 *  IVA line below, would double-count it on the page. For an untaxed line
 *  `baseAmount === totalAmount` (`taxAmount` 0), so both of these are
 *  no-ops for the common case. A taxed cargo's name also gets its rate
 *  appended (`Pintura (19%)`) so the reader can see, per row, which cargo
 *  is contributing to the IVA line below. */
function dibujarTablaConceptos(ctx: PdfContext, lines: FacturaLinea[]): void {
  const columnas = [
    'Nombre del Cargo',
    'Saldo Anterior',
    'Cargos del Mes',
    'Nuevo Saldo',
  ];
  const filas = lines.map((l) => [
    l.taxAmount > 0 ? `${l.conceptName} (${l.taxRate}%)` : l.conceptName,
    formatoPeso(l.balanceBefore),
    formatoPeso(l.baseAmount),
    formatoPeso(l.balanceBefore + l.baseAmount),
  ]);

  escribirTabla(ctx, columnas, filas, { columnasNumericas: 3 });
}

/** "Subtotal" — ALWAYS drawn, one row aligned to the SAME four columns as
 *  `dibujarTablaConceptos`'s table right above it (Nombre del Cargo / Saldo
 *  Anterior / Cargos del Mes / Nuevo Saldo), carrying the totals that used
 *  to live in that table's own "Totales" footer row. Reads as the table's
 *  running continuation rather than a second, separate totals block.
 *
 *  "IVA (tasa%)" — sum of every line's `taxAmount` — is drawn right below,
 *  but ONLY when this invoice actually carries tax (`totalIva > 0`); an
 *  invoice with no taxed cargo shows Subtotal and skips straight to "Total a
 *  Pagar", same as before this feature. The rate shown is the one common
 *  `taxRate` among the taxed lines when they all agree; a coproperty that
 *  (unusually) mixes different rates on one invoice gets the generic "IVA"
 *  label instead of a misleading single percentage. */
function dibujarSubtotal(ctx: PdfContext, lines: FacturaLinea[]): void {
  const totalAnterior = lines.reduce((acc, l) => acc + l.balanceBefore, 0);
  const totalCargos = lines.reduce((acc, l) => acc + l.baseAmount, 0);
  const totalIva = lines.reduce((acc, l) => acc + l.taxAmount, 0);

  const colWidth = ctx.contentWidth / 4;
  const valores = [totalAnterior, totalCargos, totalAnterior + totalCargos];
  ctx.page.drawText('Subtotal', {
    x: MARGIN_LEFT + 4,
    y: ctx.y,
    size: 10,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  valores.forEach((valor, indice) => {
    const texto = formatoPeso(valor);
    const textWidth = ctx.fontBold.widthOfTextAtSize(texto, 10);
    ctx.page.drawText(texto, {
      x: MARGIN_LEFT + colWidth * (indice + 2) - textWidth - 4,
      y: ctx.y,
      size: 10,
      font: ctx.fontBold,
      color: rgb(0, 0, 0),
    });
  });
  ctx.y -= 14;

  if (totalIva <= 0) return;
  const tasas = new Set(
    lines.filter((l) => l.taxAmount > 0).map((l) => l.taxRate),
  );
  const etiquetaIva = tasas.size === 1 ? `IVA (${[...tasas][0]}%)` : 'IVA';

  ctx.y -= 4;
  escribirLabelValor(ctx, etiquetaIva, formatoPeso(totalIva));
}

/** "Total a Pagar" — the sum of every concept's `nuevoSaldo`, i.e. the
 *  full amount now outstanding across the unit's whole cartera, not just
 *  what this document charges (matches the predecessor's own semantics). */
function dibujarTotalAPagar(ctx: PdfContext, lines: FacturaLinea[]): void {
  const totalAPagar = lines.reduce((acc, l) => acc + l.balanceAfter, 0);
  ctx.y -= 8;

  const barraAltura = 20;
  ctx.page.drawRectangle({
    x: MARGIN_LEFT,
    y: ctx.y - barraAltura + 6,
    width: ctx.contentWidth,
    height: barraAltura,
    color: GRIS_CLARO,
  });
  const texto = 'Total a Pagar $';
  ctx.page.drawText(texto, {
    x: MARGIN_LEFT + 10,
    y: ctx.y - 8,
    size: 11,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  const valor = formatoPeso(totalAPagar);
  const valorAncho = ctx.fontBold.widthOfTextAtSize(valor, 11);
  ctx.page.drawText(valor, {
    x: MARGIN_LEFT + ctx.contentWidth - 10 - valorAncho,
    y: ctx.y - 8,
    size: 11,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.y -= barraAltura + 4;
}

/**
 * Generates a real PDF for a Factura (sales invoice) already numbered and
 * consolidada. `resolucion` supplies both the document's own printed name
 * (`displayName`, e.g. "Cobro Expensas Comunes") and the DIAN authorisation
 * footer legally required on Colombian invoices that file electronic
 * invoicing — null for a coproperty with no active resolution, where a
 * generic Spanish title is used instead and the footer is skipped. When
 * `duplicado` is true, stamps the "DUPLICADO" mark.
 *
 * `lote` — the billing run this Factura came from — supplies the
 * early-payment discount offer (`calcularDescuentoProntoPago`); null when
 * the caller cannot resolve it (an orphaned `loteId`, in practice never
 * expected since lotes are never deleted once consolidado), in which case
 * the discount note is simply omitted, same as a coproperty with none
 * configured.
 */
export async function generarPdfFactura(
  factura: FacturaDocument,
  resolucion: ResolucionFacturacionDocument | null,
  copropiedad: CopropiedadDocument,
  lote: LoteFacturacionDocument | null,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const titulo = `${resolucion?.displayName ?? 'Cobro Expensas Comunes'} ${factura.fullNumber}`;
  const descuento = lote
    ? calcularDescuentoProntoPago(
        factura.lines,
        lote.earlyPaymentDiscount,
        lote.discountDeadline,
      )
    : null;
  const ctx = await generarContextoDocumentoFacturacion(
    {
      titulo,
      unitCode: factura.unitCode,
      holder: factura.holder,
      issueDate: factura.issueDate,
      dueDate: factura.dueDate,
      periodStart: factura.periodStart,
      periodEnd: factura.periodEnd,
      lines: factura.lines,
      descuento,
    },
    copropiedad,
  );

  if (resolucion) {
    const vigenteHasta = resolucion.validUntil
      ? ` vigente hasta ${formatoFecha(resolucion.validUntil)}`
      : '';
    const resolucionTexto =
      `Resolución de Facturación DIAN No. ${resolucion.resolutionNumber} ` +
      `del ${formatoFecha(resolucion.validFrom)}. ` +
      `Numeración autorizada de ${resolucion.prefix}${resolucion.rangeFrom} ` +
      `a ${resolucion.prefix}${resolucion.rangeTo}${vigenteHasta}`;
    escribirLinea(ctx, resolucionTexto, { size: 8 });
  }

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, factura.issueDate.toISOString());
  }

  return ctx.doc.save();
}
