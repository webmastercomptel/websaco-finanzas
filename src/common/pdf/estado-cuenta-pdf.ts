import { createElement } from 'react';
import { View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso, formatoSaldoConFavor } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { BloqueInmueblePeriodo } from './react/bloque-inmueble-periodo';
import { TablaResumen } from './react/tabla-resumen';
import { TituloSeccion } from './react/titulo-seccion';
import { Tabla } from './react/tabla';
import { MarcaDuplicado } from './react/marca-duplicado';
import { CreditoWebsaco } from './react/credito-websaco';
import { ROJO_DANGER, VERDE_OK } from './react/paleta';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaEstadoCuenta } from '../../contracts';

const ESTADO_LABELS: Record<string, string> = {
  al_dia: 'Al Día',
  vencido: 'Vencida',
};

/** Same weights as the pdf-lib original's `ANCHOS_MOVIMIENTOS` — Concepto
 *  gets the lion's share, no separate "Tipo Doc." column since `número`
 *  already carries its own type prefix (e.g. "FV-0012"). */
const ANCHOS_MOVIMIENTOS = [0.9, 1.1, 2.2, 1, 1];

/**
 * Generates a real PDF for an Estado de Cuenta (owner statement). React-pdf,
 * built directly (no pdf-lib version kept behind a `?version=` toggle).
 * Unlike the other builders which take raw Mongoose documents, this one
 * takes the computed contract directly — the service already resolved all
 * the data the JSON endpoint returns.
 *
 * Reuses `EncabezadoDocumento` with `soloNit` (only NIT under the name) and
 * the WebSACO mark per `showLogoOnDocuments`, then the same Inmueble/Nombre +
 * Periodo block as Auxiliar de Cartera (`BloqueInmueblePeriodo`) — product
 * request 2026-09-28, which also dropped the "Generado:" timestamp row the
 * Auxiliar never had. Closes with `CreditoWebsaco` ("Generado con" +
 * "Página i/N" in one row), the same footer every other document carries.
 */
export async function generarPdfEstadoCuenta(
  estado: RespuestaEstadoCuenta,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Buffer> {
  const estadoTexto =
    estado.diasMoraMaximo != null
      ? `${ESTADO_LABELS[estado.estado] ?? estado.estado} — ${estado.diasMoraMaximo} días de mora`
      : (ESTADO_LABELS[estado.estado] ?? estado.estado);

  const totalCargo = estado.movimientos.reduce(
    (sum, m) => sum + (m.cargo ?? 0),
    0,
  );
  const totalAbono = estado.movimientos.reduce(
    (sum, m) => sum + (m.abono ?? 0),
    0,
  );

  const contenido = createElement(
    View,
    null,
    opciones?.duplicado
      ? createElement(MarcaDuplicado, { fechaEmisionIso: estado.fechaEmision })
      : null,
    createElement(EncabezadoDocumento, {
      copropiedad,
      titulo: 'Estado de Cuenta',
      mostrarLogo: copropiedad.showLogoOnDocuments,
      soloNit: true,
    }),

    createElement(BloqueInmueblePeriodo, {
      inmuebleCodigo: estado.inmuebleCodigo,
      propietario: estado.propietario,
      desde: formatoFecha(estado.periodStart),
      hasta: formatoFecha(estado.periodEnd),
    }),

    createElement(TituloSeccion, { texto: 'Resumen de Saldos' }),
    createElement(TablaResumen, {
      filas: [
        { label: 'Saldo anterior', valor: formatoPeso(estado.saldoAnterior) },
        { label: 'Cargos', valor: formatoPeso(estado.cargosDelMes) },
        {
          label: 'Pagos',
          valor: `-${formatoPeso(estado.pagosDelMes)}`,
          color: VERDE_OK,
        },
        {
          label: 'Anticipos Aplicados',
          valor: `-${formatoPeso(estado.anticiposAplicados)}`,
          color: VERDE_OK,
        },
        {
          label: 'Descuentos y ajustes',
          valor: `-${formatoPeso(estado.descuentosAjustes)}`,
          color: VERDE_OK,
        },
        {
          label: 'Saldo actual',
          valor: formatoSaldoConFavor(estado.saldoActual),
          destacada: true,
        },
        {
          label: 'Estado de la Cartera',
          valor: estadoTexto,
          color: estado.estado === 'vencido' ? ROJO_DANGER : VERDE_OK,
        },
      ],
    }),

    estado.movimientos.length > 0
      ? createElement(
          View,
          null,
          createElement(TituloSeccion, { texto: 'Detalle de Movimientos' }),
          createElement(Tabla, {
            columnas: ['Fecha', 'Número', 'Concepto', 'Cargo', 'Abono'],
            filas: estado.movimientos.map((m) => [
              formatoFecha(m.fecha),
              m.numeroCompleto,
              m.concepto,
              m.cargo != null ? formatoPeso(m.cargo) : '',
              m.abono != null ? formatoPeso(m.abono) : '',
            ]),
            columnasNumericas: 2,
            anchosRelativos: ANCHOS_MOVIMIENTOS,
            striped: true,
            fontSize: 8.5,
            filaTotales:
              estado.movimientos.length > 1
                ? [
                    'Total',
                    '',
                    '',
                    formatoPeso(totalCargo),
                    formatoPeso(totalAbono),
                  ]
                : undefined,
          }),
        )
      : null,

    estado.anticipos.length > 0
      ? createElement(
          View,
          null,
          createElement(TituloSeccion, { texto: 'Anticipos Pendientes' }),
          createElement(Tabla, {
            columnas: ['Recibo', 'Fecha', 'Saldo Disponible'],
            filas: estado.anticipos.map((a) => [
              a.numeroCompleto,
              formatoFecha(a.fecha),
              formatoPeso(a.monto),
            ]),
            columnasNumericas: 1,
            striped: true,
            fontSize: 8.5,
          }),
        )
      : null,

    createElement(CreditoWebsaco, {}),
  );

  return renderizarPdf(reporteDocumento(contenido));
}
