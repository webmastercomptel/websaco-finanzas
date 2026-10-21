import { LoteComptableSchema } from './lote-comptable.schema';
import { AsientoContableSchema } from '../facturacion/asiento-contable.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

describe('LoteComptable schema', () => {
  const indices = LoteComptableSchema.indexes() as unknown as IndiceDeclarado[];

  it('un solo lote pendiente por copropiedad (dos "Enviar" a la vez → un lote)', () => {
    const indice = indices.find(
      ([, opciones]) => opciones.name === 'copropiedadId_pendiente_unico',
    );

    expect(indice).toBeDefined();
    expect(indice![0]).toEqual({ copropiedadId: 1 });
    expect(indice![1]).toMatchObject({
      unique: true,
      partialFilterExpression: { estado: 'pendiente' },
    });
  });

  it('numeración única por copropiedad', () => {
    expect(
      indices.some(
        ([clave, opciones]) =>
          JSON.stringify(clave) === '{"copropiedadId":1,"numero":1}' &&
          opciones.unique === true,
      ),
    ).toBe(true);
  });

  it('los estados son pendiente, enviado, fallido y retirado', () => {
    expect(LoteComptableSchema.path('estado').options.enum).toEqual([
      'pendiente',
      'enviado',
      'fallido',
      'retirado',
    ]);
  });
});

describe('AsientoContable — marca propia del canal Comptable', () => {
  it('tiene comptableLoteId y comptableLoteRetiradoId, nulos por defecto', () => {
    expect(
      AsientoContableSchema.path('comptableLoteId').options.default,
    ).toBeNull();
    expect(
      AsientoContableSchema.path('comptableLoteRetiradoId').options.default,
    ).toBeNull();
  });

  it('indexa la búsqueda de pendientes por copropiedad y marca de Comptable', () => {
    const indices =
      AsientoContableSchema.indexes() as unknown as IndiceDeclarado[];

    expect(
      indices.some(
        ([clave]) =>
          JSON.stringify(clave) ===
          '{"copropiedadId":1,"comptableLoteId":1,"fecha":1}',
      ),
    ).toBe(true);
  });
});
