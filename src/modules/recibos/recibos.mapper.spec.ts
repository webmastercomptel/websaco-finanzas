import { Types } from 'mongoose';
import {
  toAplicacionCartera,
  toRecibo,
  toReciboDetalle,
} from './recibos.mapper';

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'rec-1' },
  inmuebleId: { toString: () => 'inm-1' },
  terceroId: { toString: () => 'ter-1' },
  prefix: 'RC',
  number: 84,
  fullNumber: 'RC-84',
  receivedAmount: 500000,
  receivedDate: new Date('2026-08-27'),
  paymentMethod: 'transferencia',
  destinationAccount: '111005',
  reference: 'CUS123',
  notes: null,
  appliedAmount: 200000,
  unappliedAmount: 300000,
  status: 'activo',
  voidedReason: null,
  voidedDetail: null,
  voidedAt: null,
  ...over,
});

const aplicacionDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'apl-1' },
  sourceType: 'RC',
  sourceId: { toString: () => 'rec-1' },
  documentType: 'FV',
  documentId: { toString: () => 'fac-1' },
  amountApplied: 200000,
  status: 'activa',
  appliedAt: new Date('2026-08-27'),
  ...over,
});

describe('toRecibo', () => {
  it('mapea el documento inglés al contrato español', () => {
    expect(toRecibo(reciboDoc() as never)).toMatchObject({
      id: 'rec-1',
      numeroCompleto: 'RC-84',
      montoRecibido: 500000,
      montoAplicado: 200000,
      montoSinAplicar: 300000,
      medioPago: 'transferencia',
      estado: 'activo',
    });
  });

  it('expone la fecha de anulación solo cuando existe', () => {
    const anulado = toRecibo(
      reciboDoc({
        status: 'anulado',
        voidedReason: 'duplicado',
        voidedDetail: 'Cargado dos veces por error del cajero',
        voidedAt: new Date('2026-08-28'),
      }) as never,
    );

    expect(anulado.estado).toBe('anulado');
    expect(anulado.motivoAnulacion).toBe('duplicado');
    expect(anulado.fechaAnulacion).toBe('2026-08-28T00:00:00.000Z');
  });
});

describe('toAplicacionCartera', () => {
  it('mapea una aplicación, con su sourceType/sourceId', () => {
    expect(toAplicacionCartera(aplicacionDoc() as never)).toEqual({
      id: 'apl-1',
      sourceType: 'RC',
      sourceId: 'rec-1',
      tipoDocumento: 'FV',
      documentoId: 'fac-1',
      montoAplicado: 200000,
      estado: 'activa',
      fecha: '2026-08-27T00:00:00.000Z',
    });
  });
});

describe('toReciboDetalle', () => {
  it('agrega el arreglo de aplicaciones al recibo', () => {
    const detalle = toReciboDetalle(reciboDoc() as never, [
      aplicacionDoc() as never,
    ]);

    expect(detalle.id).toBe('rec-1');
    expect(detalle.aplicaciones).toHaveLength(1);
    expect(detalle.aplicaciones[0]).toMatchObject({ id: 'apl-1' });
  });
});
