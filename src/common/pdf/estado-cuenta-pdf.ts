import { rgb } from 'pdf-lib';
import {
  crearContexto,
  dibujarEncabezadoDocumento,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  formatoPeso,
  formatoFecha,
  type PdfContext,
} from './pdf-helpers';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaEstadoCuenta } from '../../contracts';

const ESTADO_LABELS: Record<string, string> = {
  al_dia: 'Al Día',
  vencido: 'Vencida',
};

/** Fecha, Número, Concepto, Cargo, Abono — relative weights summing to
 *  `ctx.contentWidth` on portrait. No separate "Tipo Doc." column: `número`
 *  already carries its own type prefix (e.g. "FV-0012"). Concepto gets the
 *  lion's share — a short document-type name, but still the longest fixed
 *  label ("Descuento Pronto Pago") among these columns. */
const ANCHOS_MOVIMIENTOS = [0.9, 1.1, 2.2, 1, 1];

const MARGIN_LEFT = 50;
/** Below `pdf-helpers`' own BOTTOM_MARGIN (50) — clear of any body content,
 *  which already breaks to a new page before reaching this low. */
const FOOTER_Y = 30;

/**
 * Stamps every page with the copropiedad's contact info (left) and
 * "Página i/N" (right) — done once at the very end, since the final page
 * count is only known once all content has been drawn.
 */
function escribirPiePagina(ctx: PdfContext, contactoTexto: string): void {
  const paginas = ctx.doc.getPages();
  const total = paginas.length;

  paginas.forEach((pagina, indice) => {
    if (contactoTexto) {
      pagina.drawText(contactoTexto, {
        x: MARGIN_LEFT,
        y: FOOTER_Y,
        size: 8,
        font: ctx.font,
        color: rgb(0, 0, 0),
      });
    }

    const textoPagina = `Página ${indice + 1}/${total}`;
    const anchoPagina = ctx.font.widthOfTextAtSize(textoPagina, 8);
    pagina.drawText(textoPagina, {
      x: MARGIN_LEFT + ctx.contentWidth - anchoPagina,
      y: FOOTER_Y,
      size: 8,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
  });
}

/**
 * Draws the Cargo/Abono column totals right below the Detalle de Movimientos
 * table — same `ANCHOS_MOVIMIENTOS` weights that table used, so the totals
 * land under their own columns (the last two).
 */
function escribirTotalesMovimientos(
  ctx: PdfContext,
  totalCargo: number,
  totalAbono: number,
): void {
  const pesoTotal = ANCHOS_MOVIMIENTOS.reduce((acc, p) => acc + p, 0);
  const anchos = ANCHOS_MOVIMIENTOS.map(
    (p) => (p / pesoTotal) * ctx.contentWidth,
  );
  const xInicioCol = (i: number): number =>
    MARGIN_LEFT + anchos.slice(0, i).reduce((acc, a) => acc + a, 0);

  ctx.page.drawText('Total', {
    x: MARGIN_LEFT + 4,
    y: ctx.y,
    size: 10,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const cargoTexto = formatoPeso(totalCargo);
  const cargoWidth = ctx.fontBold.widthOfTextAtSize(cargoTexto, 10);
  ctx.page.drawText(cargoTexto, {
    x: xInicioCol(3) + anchos[3] - cargoWidth - 4,
    y: ctx.y,
    size: 10,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const abonoTexto = formatoPeso(totalAbono);
  const abonoWidth = ctx.fontBold.widthOfTextAtSize(abonoTexto, 10);
  ctx.page.drawText(abonoTexto, {
    x: xInicioCol(4) + anchos[4] - abonoWidth - 4,
    y: ctx.y,
    size: 10,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  ctx.y -= 14;
  if (ctx.y < 50) {
    ctx.page = ctx.doc.addPage([ctx.pageWidth, ctx.pageHeight]);
    ctx.y = ctx.pageHeight - 50;
  }
}

/**
 * Draws one section title ("Resumen de Saldos", "Detalle de Movimientos",
 * "Anticipos Pendientes") a little lower than the body text above it, with
 * the same thin gray rule the main masthead (`dibujarEncabezadoDocumento`)
 * draws under ITS OWN title — so every title in the document, header or
 * section, reads with the same visual weight.
 */
function escribirTituloSeccion(ctx: PdfContext, texto: string): void {
  ctx.y -= 14;
  escribirLinea(ctx, texto, { bold: true });
  ctx.page.drawLine({
    start: { x: MARGIN_LEFT, y: ctx.y + 4 },
    end: { x: MARGIN_LEFT + ctx.contentWidth, y: ctx.y + 4 },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  ctx.y -= 6;
}

/**
 * Generates a real PDF for an Estado de Cuenta (owner statement).
 * Unlike the other five builders which take raw Mongoose documents,
 * this one takes the computed contract directly — the service already
 * resolved all the data the JSON endpoint returns.
 *
 * Masthead is the same shared `dibujarEncabezadoDocumento` gray-banner
 * treatment as Auxiliar de Cartera/Recibo/Nota Crédito — this report used
 * to draw its own two-row letterhead instead. The "fecha y hora de
 * generación" that row used to show on the right moved into the info
 * block below as its own "Generado:" line.
 */
export async function generarPdfEstadoCuenta(
  estado: RespuestaEstadoCuenta,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  await dibujarEncabezadoDocumento(ctx, copropiedad, 'Estado de Cuenta');

  // ── Property + owner info ──
  const ahora = new Date();
  escribirLabelValor(
    ctx,
    'Generado:',
    `${ahora.toLocaleDateString('es-CO')} ${ahora.toLocaleTimeString('es-CO')}`,
  );
  escribirLabelValor(ctx, 'Inmueble:', estado.inmuebleCodigo);
  if (estado.propietario) {
    escribirLabelValor(ctx, 'Propietario:', estado.propietario);
  }
  escribirLabelValor(
    ctx,
    'Periodo:',
    `${formatoFecha(estado.periodStart)} al ${formatoFecha(estado.periodEnd)}`,
  );

  // ── Summary ──
  escribirTituloSeccion(ctx, 'Resumen de Saldos');
  escribirLabelValor(ctx, 'Saldo anterior:', formatoPeso(estado.saldoAnterior));
  escribirLabelValor(ctx, 'Cargos del mes:', formatoPeso(estado.cargosDelMes));
  escribirLabelValor(
    ctx,
    'Pagos y Anticipos Aplicados:',
    formatoPeso(estado.pagosRecibidos),
  );
  escribirLabelValor(
    ctx,
    'Descuentos y ajustes:',
    formatoPeso(estado.descuentosAjustes),
  );
  ctx.y -= 4;
  escribirLabelValor(ctx, 'Saldo actual:', formatoPeso(estado.saldoActual));
  const estadoTexto =
    estado.diasMoraMaximo != null
      ? `${ESTADO_LABELS[estado.estado] ?? estado.estado} — ${estado.diasMoraMaximo} días de mora`
      : (ESTADO_LABELS[estado.estado] ?? estado.estado);
  escribirLabelValor(ctx, 'Estado de la Cartera:', estadoTexto);

  // ── Movements table ──
  if (estado.movimientos.length > 0) {
    escribirTituloSeccion(ctx, 'Detalle de Movimientos');
    const columnas = ['Fecha', 'Número', 'Concepto', 'Cargo', 'Abono'];
    const filas = estado.movimientos.map((m) => [
      formatoFecha(m.fecha),
      m.numeroCompleto,
      m.concepto,
      m.cargo != null ? formatoPeso(m.cargo) : '',
      m.abono != null ? formatoPeso(m.abono) : '',
    ]);
    escribirTabla(ctx, columnas, filas, {
      columnasNumericas: 2,
      anchosRelativos: ANCHOS_MOVIMIENTOS,
    });

    if (estado.movimientos.length > 1) {
      const totalCargo = estado.movimientos.reduce(
        (sum, m) => sum + (m.cargo ?? 0),
        0,
      );
      const totalAbono = estado.movimientos.reduce(
        (sum, m) => sum + (m.abono ?? 0),
        0,
      );
      escribirTotalesMovimientos(ctx, totalCargo, totalAbono);
    }
  }

  // ── Anticipos pendientes ── (live balance, not period-scoped — see the
  // service's own docblock on `anticipos`)
  if (estado.anticipos.length > 0) {
    escribirTituloSeccion(ctx, 'Anticipos Pendientes');
    const columnas = ['Recibo', 'Fecha', 'Saldo Disponible'];
    const filas = estado.anticipos.map((a) => [
      a.numeroCompleto,
      formatoFecha(a.fecha),
      formatoPeso(a.monto),
    ]);
    escribirTabla(ctx, columnas, filas, { columnasNumericas: 1 });
  }

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, estado.fechaEmision);
  }

  const contactoTexto = [estado.copropiedadTelefono, estado.copropiedadEmail]
    .filter((v): v is string => Boolean(v))
    .join(' \\ ');
  escribirPiePagina(ctx, contactoTexto);

  return ctx.doc.save();
}
