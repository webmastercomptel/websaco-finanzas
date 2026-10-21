import { Types } from 'mongoose';
import { AdicionContabilidadService } from './adicion-contabilidad.service';

/**
 * The CSV export and "Interfaz a Comptable" are independent channels, each
 * with its own stamp on AsientoContable. This pins the CSV side: it neither
 * reads nor writes the Comptable stamps (`comptableLoteId`,
 * `comptableLoteRetiradoId`), so an entry already sent to Comptable is still
 * exported, and exporting never marks anything as sent to Comptable.
 */
describe('AdicionContabilidadService — independiente del canal Comptable', () => {
  const COP = new Types.ObjectId();
  const reciboId = new Types.ObjectId();

  const modeloCon = (docs: Record<string, unknown>[]) => ({
    find: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(docs) }),
    })),
  });

  it('genera con asientos ya enviados a Comptable y solo escribe su propia marca', async () => {
    const asientoEnviado = {
      _id: new Types.ObjectId(),
      copropiedadId: COP,
      facturaId: null,
      reciboId,
      notaCreditoId: null,
      notaDebitoId: null,
      notaContableId: null,
      notaAnticipoId: null,
      fecha: new Date('2026-10-05'),
      movimientos: [
        { cuenta: '1110', tipo: 'debito', monto: 10, descripcion: 'x' },
        { cuenta: '1305', tipo: 'credito', monto: 10, descripcion: 'y' },
      ],
      contabilidadLoteId: null,
      comptableLoteId: new Types.ObjectId(),
    };
    const filtros: Record<string, unknown>[] = [];
    const asientos = {
      find: jest.fn((filtro: Record<string, unknown>) => {
        filtros.push(filtro);
        return {
          sort: () => ({
            session: () => ({
              exec: () => Promise.resolve([asientoEnviado]),
            }),
          }),
        };
      }),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    const lotes = {
      create: jest.fn((docs: Record<string, unknown>[]) =>
        Promise.resolve(
          docs.map((d) => ({
            ...d,
            _id: new Types.ObjectId(),
            createdAt: new Date(),
          })),
        ),
      ),
    };
    const service = new AdicionContabilidadService(
      asientos as never,
      lotes as never,
      {
        findOneAndUpdate: () => ({
          exec: () => Promise.resolve({ nextNumber: 1 }),
        }),
      } as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([
        { _id: reciboId, prefijo: 'RC', numero: 5, observaciones: 'Pago' },
      ]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      { resolveCoPropertyId: () => COP } as never,
      {
        obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
          periodoDesde: new Date('2026-10-01'),
          periodoHasta: new Date('2026-10-31'),
        }),
      } as never,
      {
        startSession: () =>
          Promise.resolve({
            withTransaction: (fn: () => Promise<void>) => fn(),
            endSession: () => Promise.resolve(undefined),
          }),
      } as never,
    );

    const resultado = await service.generar({
      accountId: new Types.ObjectId().toString(),
      nombre: 'Contadora',
    });

    expect(resultado.movmes).toContain('Pago');
    expect(JSON.stringify(filtros[0])).not.toContain('comptable');
    const [, actualizacion] = asientos.updateMany.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(Object.keys(actualizacion.$set)).toEqual(['contabilidadLoteId']);
  });
});
