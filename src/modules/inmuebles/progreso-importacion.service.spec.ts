import { Types } from 'mongoose';
import { ProgresoImportacionService } from './progreso-importacion.service';

const COP = new Types.ObjectId();

const modeloCon = (encontrado: Record<string, unknown> | null = null) => {
  const escrituras: Record<string, unknown>[] = [];
  const filtros: Record<string, unknown>[] = [];
  return {
    escrituras,
    filtros,
    updateOne: jest.fn((filtro: Record<string, unknown>, update) => {
      filtros.push(filtro);
      escrituras.push(update as Record<string, unknown>);
      return { exec: () => Promise.resolve(undefined) };
    }),
    deleteOne: jest.fn((filtro: Record<string, unknown>) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(undefined) };
    }),
    findOne: jest.fn((filtro: Record<string, unknown>) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(encontrado) };
    }),
  };
};

describe('ProgresoImportacionService', () => {
  it('intervalo() lo tapa en ~20 escrituras totales sin importar cuántas filas haya', () => {
    const service = new ProgresoImportacionService({} as never);

    expect(service.intervalo(5)).toBe(1);
    expect(service.intervalo(100)).toBe(5);
    expect(service.intervalo(1000)).toBe(50);
  });

  it('iniciar() con total 0 no escribe nada — no hay nada que sondear', async () => {
    const modelo = modeloCon();
    const service = new ProgresoImportacionService(modelo as never);

    await service.iniciar(COP, 'inmuebles', 0);

    expect(modelo.updateOne).not.toHaveBeenCalled();
  });

  it('iniciar() con filas hace upsert de current:0', async () => {
    const modelo = modeloCon();
    const service = new ProgresoImportacionService(modelo as never);

    await service.iniciar(COP, 'inmuebles', 10);

    expect(modelo.filtros[0]).toEqual({ coPropertyId: COP, kind: 'inmuebles' });
    expect(modelo.escrituras[0]).toEqual({ $set: { current: 0, total: 10 } });
  });

  it('actualizar() hace upsert del progreso actual', async () => {
    const modelo = modeloCon();
    const service = new ProgresoImportacionService(modelo as never);

    await service.actualizar(COP, 'valores-recurrentes', 3, 10);

    expect(modelo.escrituras[0]).toEqual({ $set: { current: 3, total: 10 } });
  });

  it('finalizar() borra la fila — su ausencia ES "nada en curso"', async () => {
    const modelo = modeloCon();
    const service = new ProgresoImportacionService(modelo as never);

    await service.finalizar(COP, 'inmuebles');

    expect(modelo.deleteOne).toHaveBeenCalledWith({
      coPropertyId: COP,
      kind: 'inmuebles',
    });
  });

  it('obtener() devuelve null cuando no hay fila', async () => {
    const modelo = modeloCon(null);
    const service = new ProgresoImportacionService(modelo as never);

    await expect(service.obtener(COP, 'inmuebles')).resolves.toBeNull();
  });

  it('obtener() mapea current/total a actual/total', async () => {
    const modelo = modeloCon({ current: 4, total: 9 });
    const service = new ProgresoImportacionService(modelo as never);

    await expect(service.obtener(COP, 'inmuebles')).resolves.toEqual({
      actual: 4,
      total: 9,
    });
  });
});
