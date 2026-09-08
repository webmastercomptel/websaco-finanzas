import { rgb } from 'pdf-lib';
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
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaEstadoCuenta } from '../../contracts';

const ESTADO_LABELS: Record<string, string> = {
  al_dia: 'Cancelado',
  pendiente: 'Pendiente',
  vencido: 'Vencido',
};

const MARGIN_LEFT = 50;
/** Below `pdf-helpers`' own BOTTOM_MARGIN (50) — clear of any body content,
 *  which already breaks to a new page before reaching this low. */
const FOOTER_Y = 30;

/**
 * Estado de Cuenta's own two-row letterhead (distinct from `escribirEncabezado`,
 * which every other PDF in this module uses):
 *   Row 1 — copropiedad name (left) / fecha y hora en que se generó este PDF (right)
 *   Row 2 — NIT + dígito de verificación (left) / logo WebSACO, pequeño (right)
 * followed by the centered document title.
 */
async function escribirEncabezadoEstadoCuenta(
  ctx: PdfContext,
  copropiedad: CopropiedadDocument,
): Promise<void> {
  const ahora = new Date();
  const fechaHoraEmision = `${ahora.toLocaleDateString('es-CO')} ${ahora.toLocaleTimeString('es-CO')}`;

  // Row 1: name (left) / fecha y hora de emisión del PDF (right)
  ctx.page.drawText(copropiedad.name, {
    x: MARGIN_LEFT,
    y: ctx.y,
    size: 14,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  const anchoFechaHora = ctx.font.widthOfTextAtSize(fechaHoraEmision, 10);
  ctx.page.drawText(fechaHoraEmision, {
    x: MARGIN_LEFT + ctx.contentWidth - anchoFechaHora,
    y: ctx.y + 2,
    size: 10,
    font: ctx.font,
    color: rgb(0, 0, 0),
  });
  ctx.y -= 20;

  // Row 2: NIT (left) / logo, small (right)
  if (copropiedad.taxId) {
    const nit = copropiedad.taxIdVerificationDigit
      ? `NIT ${copropiedad.taxId}-${copropiedad.taxIdVerificationDigit}`
      : `NIT ${copropiedad.taxId}`;
    ctx.page.drawText(nit, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size: 10,
      font: ctx.font,
      color: rgb(0, 0, 0),
    });
  }

  const {
    image: logo,
    width: logoWidth,
    height: logoHeight,
  } = await embebirLogoWebsaco(ctx.doc);
  ctx.page.drawImage(logo, {
    x: MARGIN_LEFT + ctx.contentWidth - logoWidth,
    y: ctx.y - logoHeight + 9,
    width: logoWidth,
    height: logoHeight,
  });

  ctx.y -= Math.max(20, logoHeight) + 8;

  // Document title, centered
  const titulo = 'ESTADO DE CUENTA';
  const tituloWidth = ctx.fontBold.widthOfTextAtSize(titulo, 14);
  ctx.page.drawText(titulo, {
    x: MARGIN_LEFT + (ctx.contentWidth - tituloWidth) / 2,
    y: ctx.y,
    size: 14,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.y -= 22;
}

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
 * table — same 4-column layout `escribirTabla` used for it (Fecha, Concepto,
 * Cargo, Abono), so the totals land under their own columns.
 */
function escribirTotalesMovimientos(
  ctx: PdfContext,
  totalCargo: number,
  totalAbono: number,
): void {
  const colWidth = ctx.contentWidth / 4;

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
    x: MARGIN_LEFT + colWidth * 3 - cargoWidth - 4,
    y: ctx.y,
    size: 10,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });

  const abonoTexto = formatoPeso(totalAbono);
  const abonoWidth = ctx.fontBold.widthOfTextAtSize(abonoTexto, 10);
  ctx.page.drawText(abonoTexto, {
    x: MARGIN_LEFT + colWidth * 4 - abonoWidth - 4,
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
 * Generates a real PDF for an Estado de Cuenta (owner statement).
 * Unlike the other five builders which take raw Mongoose documents,
 * this one takes the computed contract directly — the service already
 * resolved all the data the JSON endpoint returns.
 */
export async function generarPdfEstadoCuenta(
  estado: RespuestaEstadoCuenta,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  await escribirEncabezadoEstadoCuenta(ctx, copropiedad);

  // ── Property + owner info ──
  escribirLabelValor(ctx, 'Inmueble:', estado.inmuebleCodigo);
  if (estado.propietario) {
    escribirLabelValor(ctx, 'Propietario:', estado.propietario);
  }
  escribirLabelValor(
    ctx,
    'Periodo:',
    `${formatoFecha(estado.periodStart)} al ${formatoFecha(estado.periodEnd)}`,
  );
  if (estado.fechaEmision) {
    escribirLabelValor(
      ctx,
      'Fecha de emisión:',
      formatoFecha(estado.fechaEmision),
    );
  }
  if (estado.vencimiento) {
    escribirLabelValor(ctx, 'Vencimiento:', formatoFecha(estado.vencimiento));
  }

  // ── Summary ──
  ctx.y -= 10;
  escribirLinea(ctx, 'Resumen de Saldos', { bold: true });
  escribirLabelValor(ctx, 'Saldo anterior:', formatoPeso(estado.saldoAnterior));
  escribirLabelValor(ctx, 'Cargos del mes:', formatoPeso(estado.cargosDelMes));
  escribirLabelValor(
    ctx,
    'Pagos recibidos:',
    formatoPeso(estado.pagosRecibidos),
  );
  escribirLabelValor(
    ctx,
    'Descuentos y ajustes:',
    formatoPeso(estado.descuentosAjustes),
  );
  ctx.y -= 4;
  escribirLabelValor(ctx, 'Saldo actual:', formatoPeso(estado.saldoActual));
  escribirLabelValor(
    ctx,
    'Estado del Pago:',
    ESTADO_LABELS[estado.estado] ?? estado.estado,
  );

  // ── Movements table ──
  if (estado.movimientos.length > 0) {
    ctx.y -= 10;
    escribirLinea(ctx, 'Detalle de Movimientos', { bold: true });
    const columnas = ['Fecha', 'Concepto', 'Cargo', 'Abono'];
    const filas = estado.movimientos.map((m) => [
      formatoFecha(m.fecha),
      m.concepto,
      m.cargo != null ? formatoPeso(m.cargo) : '',
      m.abono != null ? formatoPeso(m.abono) : '',
    ]);
    escribirTabla(ctx, columnas, filas);

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

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, estado.fechaEmision);
  }

  const contactoTexto = [estado.copropiedadTelefono, estado.copropiedadEmail]
    .filter((v): v is string => Boolean(v))
    .join(' \\ ');
  escribirPiePagina(ctx, contactoTexto);

  return ctx.doc.save();
}
