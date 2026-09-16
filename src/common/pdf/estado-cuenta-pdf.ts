import { createElement } from 'react';
import { View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { FilaInfo } from './react/fila-info';
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
 * Reuses `EncabezadoDocumento` — its own docblock already names Estado de
 * Cuenta as a second consumer alongside Factura. Closes with `CreditoWebsaco`
 * ("Generado por" + "Página i/N" in one row) instead of a separate footer —
 * that footer's own contact-info half would be redundant: `EncabezadoDocumento`'s
 * info block already shows Celular and Email up top.
 */
export async function generarPdfEstadoCuenta(
  estado: RespuestaEstadoCuenta,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Buffer> {
  const ahora = new Date();
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
    }),

    createElement(FilaInfo, {
      label: 'Generado:',
      valor: `${ahora.toLocaleDateString('es-CO')} ${ahora.toLocaleTimeString('es-CO')}`,
    }),
    createElement(FilaInfo, {
      label: 'Inmueble:',
      valor: estado.inmuebleCodigo,
    }),
    estado.propietario
      ? createElement(FilaInfo, {
          label: 'Propietario:',
          valor: estado.propietario,
        })
      : null,
    createElement(FilaInfo, {
      label: 'Periodo:',
      valor: `${formatoFecha(estado.periodStart)} al ${formatoFecha(estado.periodEnd)}`,
    }),

    createElement(TituloSeccion, { texto: 'Resumen de Saldos' }),
    createElement(TablaResumen, {
      filas: [
        { label: 'Saldo anterior', valor: formatoPeso(estado.saldoAnterior) },
        { label: 'Cargos del mes', valor: formatoPeso(estado.cargosDelMes) },
        {
          label: 'Pagos y Anticipos Aplicados',
          valor: `-${formatoPeso(estado.pagosRecibidos)}`,
          color: VERDE_OK,
        },
        {
          label: 'Descuentos y ajustes',
          valor: `-${formatoPeso(estado.descuentosAjustes)}`,
          color: VERDE_OK,
        },
        {
          label: 'Saldo actual',
          valor: formatoPeso(estado.saldoActual),
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

    createElement(CreditoWebsaco),
  );

  return renderizarPdf(reporteDocumento(contenido));
}
