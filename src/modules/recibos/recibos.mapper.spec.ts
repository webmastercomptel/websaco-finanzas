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
  prefijo: 'RC',
  numero: 84,
  numeroCompleto: 'RC-84',
  montoRecibido: 500000,
  fechaRecibo: new Date('2026-08-27'),
  medioPago: 'transferencia',
  cuentaDestino: '111005',
  referencia: 'CUS123',
  observaciones: null,
  estado: 'activo',
  motivoAnulacion: null,
  detalleAnulacion: null,
  fechaAnulacion: null,
  ...over,
});

const aplicacionDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'apl-1' },
  sourceType: 'RC',
  sourceId: { toString: () => 'rec-1' },
  tipoDocumento: 'FV',
  documentoId: { toString: () => 'fac-1' },
  montoAplicado: 200000,
  estado: 'activa',
  aplicadoEn: new Date('2026-08-27'),
  ...over,
});

describe('toRecibo', () => {
  it('mapea el documento inglés al contrato español', () => {
    expect(
      toRecibo(reciboDoc() as never, 200000, 300000, 'A-101'),
    ).toMatchObject({
      id: 'rec-1',
      numeroCompleto: 'RC-84',
      montoRecibido: 500000,
      montoAplicado: 200000,
      montoSinAplicar: 300000,
      medioPago: 'transferencia',
      estado: 'activo',
      inmuebleCodigo: 'A-101',
    });
  });

  it('expone la fecha de anulación solo cuando existe', () => {
    const anulado = toRecibo(
      reciboDoc({
        estado: 'anulado',
        motivoAnulacion: 'duplicado',
        detalleAnulacion: 'Cargado dos veces por error del cajero',
        fechaAnulacion: new Date('2026-08-28'),
      }) as never,
      0,
      0,
      'A-101',
    );

    expect(anulado.estado).toBe('anulado');
    expect(anulado.motivoAnulacion).toBe('duplicado');
    expect(anulado.fechaAnulacion).toBe('2026-08-28T00:00:00.000Z');
  });
});

describe('toAplicacionCartera', () => {
  it('mapea una aplicación, con su sourceType/sourceId', () => {
    expect(
      toAplicacionCartera(
        aplicacionDoc() as never,
        null,
        new Date('2026-08-27'),
      ),
    ).toEqual({
      id: 'apl-1',
      sourceType: 'RC',
      sourceId: 'rec-1',
      tipoDocumento: 'FV',
      documentoId: 'fac-1',
      numeroDocumento: null,
      montoAplicado: 200000,
      detalleConceptos: [],
      estado: 'activa',
      fecha: '2026-08-27T00:00:00.000Z',
    });
  });

  it('usa la fecha que el caller pasa explícitamente, NUNCA aplicadoEn (el instante real del cruce)', () => {
    // `aplicadoEn` en la fixture es 2026-08-27, pero el caller declara que la
    // fecha de negocio real es otra — si la función leyera `doc.aplicadoEn`
    // por su cuenta, este test lo detectaría.
    const resultado = toAplicacionCartera(
      aplicacionDoc({ aplicadoEn: new Date('2026-08-27') }) as never,
      null,
      new Date('2026-06-02'),
    );
    expect(resultado.fecha).toBe('2026-06-02T00:00:00.000Z');
  });

  it('recibe numeroDocumento como segundo parámetro explícito, nunca posicional vía .map', () => {
    expect(
      toAplicacionCartera(
        aplicacionDoc() as never,
        'FV-1',
        new Date('2026-08-27'),
      ),
    ).toMatchObject({ numeroDocumento: 'FV-1' });
  });

  it('mapea detalleConceptos, congelando el nombre del concepto', () => {
    const conceptoId = new Types.ObjectId();
    const doc = aplicacionDoc({
      detalleConceptos: [
        { conceptoId, nombreConcepto: 'Administración', monto: 150000 },
        {
          conceptoId: new Types.ObjectId(),
          nombreConcepto: 'Pintura',
          monto: 50000,
        },
      ],
    });

    expect(
      toAplicacionCartera(doc as never, null, new Date('2026-08-27'))
        .detalleConceptos,
    ).toEqual([
      {
        conceptoId: conceptoId.toString(),
        nombreConcepto: 'Administración',
        monto: 150000,
      },
      expect.objectContaining({ nombreConcepto: 'Pintura', monto: 50000 }),
    ]);
  });
});

describe('toReciboDetalle', () => {
  it('agrega el arreglo de aplicaciones al recibo', () => {
    const detalle = toReciboDetalle(
      reciboDoc() as never,
      200000,
      300000,
      [aplicacionDoc() as never],
      'A-101',
    );

    expect(detalle.id).toBe('rec-1');
    expect(detalle.aplicaciones).toHaveLength(1);
    expect(detalle.aplicaciones[0]).toMatchObject({ id: 'apl-1' });
  });

  it('resuelve numeroDocumento de cada aplicación desde el mapa del caller', () => {
    const detalle = toReciboDetalle(
      reciboDoc() as never,
      200000,
      300000,
      [aplicacionDoc() as never],
      'A-101',
      new Map([['fac-1', 'FV-1']]),
    );

    expect(detalle.aplicaciones[0]).toMatchObject({
      documentoId: 'fac-1',
      numeroDocumento: 'FV-1',
    });
  });
});
