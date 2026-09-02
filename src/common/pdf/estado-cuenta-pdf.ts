import { rgb } from 'pdf-lib';
import {
  crearContexto,
  escribirLinea,
  escribirLabelValor,
  escribirTabla,
  escribirMarcaDuplicado,
  formatoPeso,
  formatoFecha,
} from './pdf-helpers';
import type { RespuestaEstadoCuenta } from '../../contracts';

const ESTADO_LABELS: Record<string, string> = {
  al_dia: 'Al día',
  pendiente: 'Pendiente',
  vencido: 'Vencido',
};

/**
 * Generates a real PDF for an Estado de Cuenta (owner statement).
 * Unlike the other five builders which take raw Mongoose documents,
 * this one takes the computed contract directly — the service already
 * resolved all the data the JSON endpoint returns.
 */
export async function generarPdfEstadoCuenta(
  estado: RespuestaEstadoCuenta,
  opciones?: { duplicado?: boolean },
): Promise<Uint8Array> {
  const ctx = await crearContexto();

  // ── Header (text-only, no CopropiedadDocument needed) ──
  ctx.page.drawText('ESTADO DE CUENTA', {
    x: 50,
    y: ctx.y,
    size: 14,
    font: ctx.fontBold,
    color: rgb(0, 0, 0),
  });
  ctx.y -= 24;

  // ── Property + owner info ──
  escribirLabelValor(ctx, 'Unidad:', estado.inmuebleCodigo);
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
    'Estado:',
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
  }

  // ── Footer ──
  if (estado.copropiedadTelefono || estado.copropiedadEmail) {
    ctx.y -= 10;
    const parts = [estado.copropiedadTelefono, estado.copropiedadEmail]
      .filter(Boolean)
      .join(' | ');
    escribirLinea(ctx, parts, { size: 8 });
  }

  if (opciones?.duplicado) {
    escribirMarcaDuplicado(ctx, estado.fechaEmision);
  }

  return ctx.doc.save();
}
