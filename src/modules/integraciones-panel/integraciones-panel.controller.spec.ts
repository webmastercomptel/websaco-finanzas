import { RequestMethod } from '@nestjs/common';
import { FirmaPanelGuard } from './firma-panel.guard';
import { IntegracionesPanelController } from './integraciones-panel.controller';
import { PanelHabilitadoGuard } from './panel-habilitado.guard';

const ID = '670000000000000000000001';

const servicio = {
  listar: jest.fn(),
  fijarVinculo: jest.fn(),
};

const controlador = () => new IntegracionesPanelController(servicio as never);

describe('IntegracionesPanelController', () => {
  beforeEach(() => {
    servicio.listar.mockReset();
    servicio.fijarVinculo.mockReset();
  });

  it('se monta en integraciones/panel', () => {
    expect(Reflect.getMetadata('path', IntegracionesPanelController)).toBe(
      'integraciones/panel',
    );
  });

  it('sus únicos guards son la firma y el interruptor, en ese orden', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      IntegracionesPanelController,
    ) as unknown[];

    expect(guards).toEqual([FirmaPanelGuard, PanelHabilitadoGuard]);
  });

  it('GET registros y PUT registros/:id/vinculo', () => {
    // Looked up by name: Nest keeps the route metadata on the method itself.
    const metodo = (nombre: string): object =>
      (
        IntegracionesPanelController.prototype as unknown as Record<
          string,
          object
        >
      )[nombre];

    expect(Reflect.getMetadata('path', metodo('listar'))).toBe('registros');
    expect(Reflect.getMetadata('method', metodo('listar'))).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata('path', metodo('fijarVinculo'))).toBe(
      'registros/:id/vinculo',
    );
    expect(Reflect.getMetadata('method', metodo('fijarVinculo'))).toBe(
      RequestMethod.PUT,
    );
  });

  it('listar delega en el servicio con la consulta tal cual', async () => {
    servicio.listar.mockResolvedValue({ items: [], total: 0 });

    const res = await controlador().listar({ q: 'pinos', limite: 10 });

    expect(servicio.listar).toHaveBeenCalledWith({ q: 'pinos', limite: 10 });
    expect(res).toEqual({ items: [], total: 0 });
  });

  it('fijarVinculo delega con el id de la ruta y el cuerpo', async () => {
    servicio.fijarVinculo.mockResolvedValue({
      sistema: 'comptable',
      registroId: 'a'.repeat(24),
    });
    const cuerpo = { sistema: 'comptable', registroId: 'a'.repeat(24) };

    const res = await controlador().fijarVinculo({ id: ID }, cuerpo);

    expect(servicio.fijarVinculo).toHaveBeenCalledWith(ID, cuerpo);
    expect(res).toEqual({ sistema: 'comptable', registroId: 'a'.repeat(24) });
  });
});
