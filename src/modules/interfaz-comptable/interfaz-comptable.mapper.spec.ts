import { Types } from 'mongoose';
import { toLoteComptable } from './interfaz-comptable.mapper';

describe('toLoteComptable', () => {
  const base = {
    _id: new Types.ObjectId(),
    numero: 3,
    periodoDesde: new Date('2026-10-01T00:00:00.000Z'),
    periodoHasta: new Date('2026-10-31T00:00:00.000Z'),
    asientoIds: [new Types.ObjectId()],
    totalAsientos: 1,
    totalLineas: 2,
    totalDebitos: 350000,
    totalCreditos: 350000,
    estado: 'enviado',
    motivoFallo: null,
    comptableLoteId: 'L1',
    intervenidoMensaje: null,
    intervenidoEn: null,
    generadoPorNombre: 'Ana Pérez',
    enviadoPorNombre: 'Ana Pérez',
    enviadoEn: new Date('2026-10-21T15:00:00.000Z'),
    retiradoPorNombre: null,
    retiradoEn: null,
    createdAt: new Date('2026-10-21T14:59:00.000Z'),
  };

  it('convierte tipos y nunca expone los ids de los asientos', () => {
    const lote = toLoteComptable(base as never);

    expect(lote).toMatchObject({
      id: base._id.toString(),
      numero: 3,
      periodoDesde: '2026-10-01T00:00:00.000Z',
      estado: 'enviado',
      intervenido: false,
      enviadoEn: '2026-10-21T15:00:00.000Z',
      fechaGeneracion: '2026-10-21T14:59:00.000Z',
      retiradoEn: null,
    });
    expect(lote).not.toHaveProperty('asientoIds');
  });

  it('un lote con mensaje de intervención queda marcado como intervenido', () => {
    expect(
      toLoteComptable({
        ...base,
        intervenidoMensaje: 'Modificado en Comptable',
        intervenidoEn: new Date('2026-10-22T10:00:00.000Z'),
      } as never),
    ).toMatchObject({
      intervenido: true,
      intervenidoMensaje: 'Modificado en Comptable',
      intervenidoEn: '2026-10-22T10:00:00.000Z',
    });
  });
});
