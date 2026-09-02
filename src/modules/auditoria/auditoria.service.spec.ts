import { AuditoriaService } from './auditoria.service';

const createMockRegistros = () => ({
  create: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
});

const mockQuery = () => {
  const q = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    exec: jest.fn(),
  };
  return q;
};

describe('AuditoriaService', () => {
  let service: AuditoriaService;
  let registros: ReturnType<typeof createMockRegistros>;

  beforeEach(() => {
    registros = createMockRegistros();
    service = new AuditoriaService(registros as never);
  });

  describe('registrar', () => {
    it('creates exactly one audit entry with all fields from the input', async () => {
      registros.create.mockResolvedValueOnce({});

      await service.registrar({
        actorAccountId: '64f1a2b3c4d5e6f7a8b9c0d1',
        actorNombre: 'Admin Test',
        accion: 'crear',
        entidadTipo: 'entidad-administradora',
        entidadId: '64f1a2b3c4d5e6f7a8b9c0d2',
        entidadEtiqueta: 'Mi Entidad',
      });

      expect(registros.create).toHaveBeenCalledTimes(1);
      expect(registros.create).toHaveBeenCalledWith({
        actorAccountId: '64f1a2b3c4d5e6f7a8b9c0d1',
        actorNombre: 'Admin Test',
        accion: 'crear',
        entidadTipo: 'entidad-administradora',
        entidadId: '64f1a2b3c4d5e6f7a8b9c0d2',
        entidadEtiqueta: 'Mi Entidad',
      });
    });

    it('propagates write failures', async () => {
      registros.create.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.registrar({
          actorAccountId: 'id',
          actorNombre: 'name',
          accion: 'crear',
          entidadTipo: 'copropiedad',
          entidadId: 'eid',
          entidadEtiqueta: 'label',
        }),
      ).rejects.toThrow('write failed');
    });
  });

  describe('findAll', () => {
    const baseItems = [
      {
        entidadTipo: 'copropiedad',
        accion: 'crear',
        createdAt: new Date('2026-08-15'),
      },
      {
        entidadTipo: 'entidad-administradora',
        accion: 'actualizar',
        createdAt: new Date('2026-08-10'),
      },
      {
        entidadTipo: 'usuario',
        accion: 'crear',
        createdAt: new Date('2026-08-05'),
      },
    ];

    let q: ReturnType<typeof mockQuery>;

    beforeEach(() => {
      q = mockQuery();
      q.exec.mockResolvedValue(baseItems);
      registros.find.mockReturnValue(q);
      registros.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(3),
      });
    });

    it('returns all items with default pagination when no filters', async () => {
      const result = await service.findAll({});

      expect(registros.find).toHaveBeenCalledWith({});
      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
      expect(result.pagina).toBe(1);
      expect(result.porPagina).toBe(50);
    });

    it('filters by entidadTipo', async () => {
      await service.findAll({ entidadTipo: 'copropiedad' });

      expect(registros.find).toHaveBeenCalledWith({
        entidadTipo: 'copropiedad',
      });
    });

    it('filters by accion', async () => {
      await service.findAll({ accion: 'crear' });

      expect(registros.find).toHaveBeenCalledWith({ accion: 'crear' });
    });

    it('filters by date range', async () => {
      await service.findAll({ desde: '2026-08-01', hasta: '2026-08-31' });

      expect(registros.find).toHaveBeenCalledWith({
        createdAt: {
          $gte: new Date('2026-08-01'),
          $lte: new Date('2026-08-31'),
        },
      });
    });

    it('filters by desde only', async () => {
      await service.findAll({ desde: '2026-08-10' });

      expect(registros.find).toHaveBeenCalledWith({
        createdAt: { $gte: new Date('2026-08-10') },
      });
    });

    it('filters by hasta only', async () => {
      await service.findAll({ hasta: '2026-08-31' });

      expect(registros.find).toHaveBeenCalledWith({
        createdAt: { $lte: new Date('2026-08-31') },
      });
    });

    it('applies custom pagination', async () => {
      await service.findAll({ pagina: 2, porPagina: 10 });

      expect(q.skip).toHaveBeenCalledWith(10);
      expect(q.limit).toHaveBeenCalledWith(10);
    });

    it('sorts by createdAt descending', async () => {
      await service.findAll({});

      expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    });
  });
});
