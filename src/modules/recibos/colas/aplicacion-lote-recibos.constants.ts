import type {
  LoteRecibos as LoteContract,
  ErrorAplicacionLoteRecibos,
} from '../../../contracts';

export const NOMBRE_COLA_APLICACION_LOTE_RECIBOS = 'aplicacion-lotes-recibos';
export const NOMBRE_TRABAJO_APLICACION_LOTE_RECIBOS = 'aplicar';
export const EVENTOS_COLA_APLICACION_LOTE_RECIBOS = Symbol(
  'EVENTOS_COLA_APLICACION_LOTE_RECIBOS',
);

export type DatosTrabajoAplicacionLoteRecibos = {
  loteId: string;
  copropiedadId: string;
  accountId: string;
};

export type ResultadoAplicacionLoteRecibos = {
  lote: LoteContract;
  errores: ErrorAplicacionLoteRecibos[];
};
