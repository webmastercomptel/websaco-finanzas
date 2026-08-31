import { toNotaCredito, toNotaCreditoDetalle } from './notas-credito.mapper';

const notaDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'nc-1' },
  inmuebleId: { toString: () => 'inm-1' },
  terceroId: { toString: () => 'ter-1' },
  facturaId: { toString: () => 'fac-1' },
  prefix: 'NC',
  number: 12,
  fullNumber: 'NC-12',
  reason: 'error_facturacion',
  totalAmount: 200000,
  distribution: [{ conceptoId: { toString: () => 'con-1' }, amount: 200000 }],
  appliedAmount: 150000,
  unappliedAmount: 50000,
  notes: null,
  status: 'activo',
  voidedReason: null,
  voidedDetail: null,
  voidedAt: null,
  ...over,
});

const aplicacionDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'apl-1' },
  sourceType: 'NC',
  sourceId: { toString: () => 'nc-1' },
  documentType: 'FV',
  documentId: { toString: () => 'fac-1' },
  amountApplied: 150000,
  status: 'activa',
  appliedAt: new Date('2026-08-30'),
  ...over,
});

describe('toNotaCredito', () => {
  it('mapea el documento inglés al contrato español', () => {
    expect(toNotaCredito(notaDoc() as never)).toEqual({
      id: 'nc-1',
      inmuebleId: 'inm-1',
      terceroId: 'ter-1',
      facturaId: 'fac-1',
      prefijo: 'NC',
      numero: 12,
      numeroCompleto: 'NC-12',
      motivo: 'error_facturacion',
      montoTotal: 200000,
      distribucion: [{ conceptoId: 'con-1', monto: 200000 }],
      montoAplicado: 150000,
      montoSinAplicar: 50000,
      observaciones: null,
      estado: 'activo',
      motivoAnulacion: null,
      detalleAnulacion: null,
      fechaAnulacion: null,
    });
  });

  it('mapea terceroId null cuando la factura ancla no tiene Tercero vinculado', () => {
    expect(toNotaCredito(notaDoc({ terceroId: null }) as never).terceroId).toBeNull();
  });

  it('expone la fecha de anulación solo cuando existe', () => {
    const anulada = toNotaCredito(
      notaDoc({
        status: 'anulado',
        voidedReason: 'duplicado',
        voidedDetail: 'Cargada dos veces por error del cajero',
        voidedAt: new Date('2026-08-30'),
      }) as never,
    );

    expect(anulada.estado).toBe('anulado');
    expect(anulada.motivoAnulacion).toBe('duplicado');
    expect(anulada.fechaAnulacion).toBe('2026-08-30T00:00:00.000Z');
  });
});

describe('toNotaCreditoDetalle', () => {
  it('agrega el arreglo de aplicaciones a la nota crédito', () => {
    const detalle = toNotaCreditoDetalle(notaDoc() as never, [
      aplicacionDoc() as never,
    ]);

    expect(detalle.id).toBe('nc-1');
    expect(detalle.aplicaciones).toHaveLength(1);
    expect(detalle.aplicaciones[0]).toMatchObject({
      id: 'apl-1',
      sourceType: 'NC',
      sourceId: 'nc-1',
    });
  });
});
