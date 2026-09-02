import { AuditoriaController } from './auditoria.controller';

describe('AuditoriaController', () => {
  it('delegates findAll to AuditoriaService and maps the result', async () => {
    const mockService = {
      findAll: jest.fn().mockResolvedValue({
        items: [
          {
            _id: { toString: () => 'aud-1' },
            actorNombre: 'Admin',
            accion: 'crear',
            entidadTipo: 'copropiedad',
            entidadEtiqueta: 'Mi Copro',
            createdAt: new Date('2026-08-15T10:00:00.000Z'),
          },
        ],
        total: 1,
        pagina: 1,
        porPagina: 50,
      }),
    };

    const controller = new AuditoriaController(mockService as never);
    const result = await controller.findAll({});

    expect(mockService.findAll).toHaveBeenCalledWith({});
    expect(result.items).toEqual([
      {
        id: 'aud-1',
        actorNombre: 'Admin',
        accion: 'crear',
        entidadTipo: 'copropiedad',
        entidadEtiqueta: 'Mi Copro',
        fecha: '2026-08-15T10:00:00.000Z',
      },
    ]);
    expect(result.total).toBe(1);
  });
});
