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
        detalle: null,
      },
    ]);
    expect(result.total).toBe(1);
  });

  it('returns the detalle of an entry that carries one (write-then-read round trip)', async () => {
    const mockService = {
      findAll: jest.fn().mockResolvedValue({
        items: [
          {
            _id: { toString: () => 'aud-2' },
            actorNombre: 'Ana',
            accion: 'actualizar',
            entidadTipo: 'rol',
            entidadEtiqueta: 'Rol X',
            createdAt: new Date('2026-08-16T10:00:00.000Z'),
            detalle: { agregadas: ['facturas.ver'], quitadas: ['pqr.ver'] },
          },
        ],
        total: 1,
        pagina: 1,
        porPagina: 50,
      }),
    };

    const controller = new AuditoriaController(mockService as never);
    const result = await controller.findAll({});

    expect(result.items[0]).toEqual({
      id: 'aud-2',
      actorNombre: 'Ana',
      accion: 'actualizar',
      entidadTipo: 'rol',
      entidadEtiqueta: 'Rol X',
      fecha: '2026-08-16T10:00:00.000Z',
      detalle: { agregadas: ['facturas.ver'], quitadas: ['pqr.ver'] },
    });
  });

  it('hides the Mongoose array wrappers: the detalle lists leave as plain arrays', async () => {
    const lista = (...claves: string[]) =>
      Object.assign([...claves], { isMongooseArray: true });
    const mockService = {
      findAll: jest.fn().mockResolvedValue({
        items: [
          {
            _id: { toString: () => 'aud-3' },
            actorNombre: 'Ana',
            accion: 'eliminar',
            entidadTipo: 'rol',
            entidadEtiqueta: 'Rol Y',
            createdAt: new Date('2026-08-17T10:00:00.000Z'),
            detalle: { agregadas: lista(), quitadas: lista('pqr.ver') },
          },
        ],
        total: 1,
        pagina: 1,
        porPagina: 50,
      }),
    };

    const controller = new AuditoriaController(mockService as never);
    const result = await controller.findAll({});

    expect(result.items[0].detalle).toStrictEqual({
      agregadas: [],
      quitadas: ['pqr.ver'],
    });
  });
});
