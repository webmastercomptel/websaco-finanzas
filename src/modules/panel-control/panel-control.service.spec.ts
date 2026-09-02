import { PanelControlService } from './panel-control.service';

const createCountMock = (count: number) => ({
  countDocuments: jest
    .fn()
    .mockReturnValue({ exec: jest.fn().mockResolvedValue(count) }),
});

describe('PanelControlService', () => {
  it('returns all three KPIs from parallel countDocuments calls', async () => {
    const entidades = createCountMock(5);
    const copropiedades = createCountMock(12);
    const accounts = createCountMock(30);

    const service = new PanelControlService(
      entidades as never,
      copropiedades as never,
      accounts as never,
    );

    const result = await service.resumen();

    expect(result).toEqual({
      totalEntidades: 5,
      totalCopropiedadesActivas: 12,
      totalUsuariosActivos: 30,
    });
  });

  it('counts entities regardless of status', async () => {
    const entidades = createCountMock(8);
    const copropiedades = createCountMock(0);
    const accounts = createCountMock(0);

    const service = new PanelControlService(
      entidades as never,
      copropiedades as never,
      accounts as never,
    );

    await service.resumen();

    expect(entidades.countDocuments).toHaveBeenCalledWith({});
  });

  it('counts only active copropiedades', async () => {
    const entidades = createCountMock(0);
    const copropiedades = createCountMock(3);
    const accounts = createCountMock(0);

    const service = new PanelControlService(
      entidades as never,
      copropiedades as never,
      accounts as never,
    );

    await service.resumen();

    expect(copropiedades.countDocuments).toHaveBeenCalledWith({
      status: 'active',
    });
  });

  it('counts only active users', async () => {
    const entidades = createCountMock(0);
    const copropiedades = createCountMock(0);
    const accounts = createCountMock(7);

    const service = new PanelControlService(
      entidades as never,
      copropiedades as never,
      accounts as never,
    );

    await service.resumen();

    expect(accounts.countDocuments).toHaveBeenCalledWith({ status: 'active' });
  });
});
