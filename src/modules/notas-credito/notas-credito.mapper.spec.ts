import { toNotaCredito, toNotaCreditoDetalle } from './notas-credito.mapper';

const notaDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'nc-1' },
  inmuebleId: { toString: () => 'inm-1' },
  terceroId: { toString: () => 'ter-1' },
  facturaId: { toString: () => 'fac-1' },
  notaDebitoId: null,
  tipoDocumentoAncla: null,
  prefix: 'NC',
  number: 12,
  fullNumber: 'NC-12',
  reason: 'ajuste_precio',
  totalAmount: 200000,
  distribution: [{ conceptoId: { toString: () => 'con-1' }, amount: 200000 }],
  appliedAmount: 150000,
  unappliedAmount: 50000,
  notes: null,
  status: 'activo',
  voidedReason: null,
  voidedDetail: null,
  voidedAt: null,
  issueDate: new Date('2026-08-15'),
  // Legacy fallback only — see `fechaNotaCredito`'s own docblock. A note
  // created with this feature always has `issueDate` set.
  createdAt: new Date('2026-07-01'),
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
    expect(toNotaCredito(notaDoc() as never, 150000, 50000, 'A-101')).toEqual({
      id: 'nc-1',
      inmuebleId: 'inm-1',
      inmuebleCodigo: 'A-101',
      terceroId: 'ter-1',
      tipoDocumentoAncla: 'FV',
      documentoAnclaId: 'fac-1',
      numeroDocumentoAncla: null,
      prefijo: 'NC',
      numero: 12,
      numeroCompleto: 'NC-12',
      fecha: '2026-08-15T00:00:00.000Z',
      motivo: 'ajuste_precio',
      montoTotal: 200000,
      distribucion: [{ conceptoId: 'con-1', monto: 200000 }],
      montoAplicado: 150000,
      montoSinAplicar: 50000,
      observaciones: null,
      estado: 'activo',
      motivoAnulacion: null,
      detalleAnulacion: null,
      fechaAnulacion: null,
      objectPath: null,
      generatedAt: null,
    });
  });

  it('cae a createdAt cuando issueDate es null (nota creada antes de este campo)', () => {
    expect(
      toNotaCredito(
        notaDoc({ issueDate: null }) as never,
        150000,
        50000,
        'A-101',
      ).fecha,
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('resuelve el ancla desde notaDebitoId cuando tipoDocumentoAncla es ND, nunca facturaId', () => {
    const nota = toNotaCredito(
      notaDoc({
        facturaId: null,
        notaDebitoId: { toString: () => 'nd-1' },
        tipoDocumentoAncla: 'ND',
      }) as never,
      150000,
      50000,
      'A-101',
    );
    expect(nota.tipoDocumentoAncla).toBe('ND');
    expect(nota.documentoAnclaId).toBe('nd-1');
  });

  it('mapea terceroId null cuando la factura ancla no tiene Tercero vinculado', () => {
    expect(
      toNotaCredito(
        notaDoc({ terceroId: null }) as never,
        150000,
        50000,
        'A-101',
      ).terceroId,
    ).toBeNull();
  });

  it('expone la fecha de anulación solo cuando existe', () => {
    const anulada = toNotaCredito(
      notaDoc({
        status: 'anulado',
        voidedReason: 'duplicado',
        voidedDetail: 'Cargada dos veces por error del cajero',
        voidedAt: new Date('2026-08-30'),
      }) as never,
      0,
      0,
      'A-101',
    );

    expect(anulada.estado).toBe('anulado');
    expect(anulada.motivoAnulacion).toBe('duplicado');
    expect(anulada.fechaAnulacion).toBe('2026-08-30T00:00:00.000Z');
  });
});

describe('toNotaCreditoDetalle', () => {
  it('resuelve numeroDocumentoAncla y numeroDocumento de cada aplicación desde numerosPorDocumento', () => {
    // `notaDoc().facturaId` y `aplicacionDoc().documentId` resuelven ambos a
    // "fac-1" en estos fixtures — una sola entrada cubre las dos lecturas.
    const numerosPorDocumento = new Map([['fac-1', 'FV-0001']]);
    const detalle = toNotaCreditoDetalle(
      notaDoc() as never,
      150000,
      50000,
      [aplicacionDoc() as never],
      'A-101',
      numerosPorDocumento,
    );

    expect(detalle.numeroDocumentoAncla).toBe('FV-0001');
    expect(detalle.aplicaciones[0].numeroDocumento).toBe('FV-0001');
  });

  it('agrega el arreglo de aplicaciones a la nota crédito', () => {
    const detalle = toNotaCreditoDetalle(
      notaDoc() as never,
      150000,
      50000,
      [aplicacionDoc() as never],
      'A-101',
    );

    expect(detalle.id).toBe('nc-1');
    expect(detalle.aplicaciones).toHaveLength(1);
    expect(detalle.aplicaciones[0]).toMatchObject({
      id: 'apl-1',
      sourceType: 'NC',
      sourceId: 'nc-1',
    });
  });
});
