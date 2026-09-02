import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntidadesService } from './entidades.service';

type Filtro = Record<string, unknown>;

const mockAuditoria = () => ({ registrar: jest.fn().mockResolvedValue(undefined) });

const ACTOR = { accountId: 'actor-1', nombre: 'Admin Test' };

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'ent-1' },
  code: 'ENT-001',
  name: 'Administraciones Calad',
  taxId: null,
  taxIdVerificationDigit: null,
  email: null,
  phone: null,
  status: 'active',
  ...over,
});

/** Chainable stub; records every filter it was called with. */
const modeloCon = (filas: unknown[], opts: { duplicado?: boolean } = {}) => {
  const filtros: Filtro[] = [];
  const escrituras: Record<string, unknown>[] = [];
  const cadena = {
    sort: () => cadena,
    skip: () => cadena,
    limit: () => cadena,
    exec: () => Promise.resolve(filas),
  };

  return {
    filtros,
    escrituras,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadena;
    }),
    findById: jest.fn(() => ({
      exec: () => Promise.resolve(filas[0] ?? null),
    })),
    countDocuments: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(filas.length) };
    }),
    exists: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return {
        exec: () => Promise.resolve(opts.duplicado ? { _id: 'x' } : null),
      };
    }),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(documento(doc));
    }),
    findByIdAndUpdate: jest.fn(
      (_id: string, update: Record<string, unknown>) => {
        escrituras.push((update as { $set: Record<string, unknown> }).$set);
        return { exec: () => Promise.resolve(documento()) };
      },
    ),
  };
};

describe('EntidadesService.findAll', () => {
  it('no filtra por copropiedad: es un catálogo por encima de cualquier edificio', () => {
    // A diferencia de Inmuebles, acá NO hay ley de tenancy que aplicar — la
    // entidad administradora no pertenece a ninguna copropiedad puntual.
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    return service.findAll({}).then(() => {
      expect(modelo.filtros[0]).not.toHaveProperty('coPropertyId');
    });
  });

  it('busca por código o por nombre', async () => {
    const modelo = modeloCon([]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await service.findAll({ buscar: 'Calad' });

    expect(modelo.filtros[0].$or).toEqual([
      { code: { $regex: 'Calad', $options: 'i' } },
      { name: { $regex: 'Calad', $options: 'i' } },
    ]);
  });

  it('muestra solo las activas por defecto', async () => {
    const modelo = modeloCon([]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await service.findAll({});

    expect(modelo.filtros[0].status).toBe('active');
  });

  it('devuelve el contrato en español', async () => {
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    const { items } = await service.findAll({});

    expect(items[0]).toMatchObject({
      codigo: 'ENT-001',
      nombre: 'Administraciones Calad',
      estado: 'activo',
    });
  });
});

describe('EntidadesService.findOne', () => {
  it('responde "no existe" cuando no hay fila', async () => {
    const modelo = modeloCon([]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await expect(service.findOne('ent-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EntidadesService.create', () => {
  it('rechaza un código repetido con un mensaje entendible', async () => {
    const modelo = modeloCon([], { duplicado: true });
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await expect(
      service.create({ codigo: 'ENT-001', nombre: 'Otra' }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea con los campos traducidos al inglés', async () => {
    const modelo = modeloCon([]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await service.create({ codigo: 'ENT-002', nombre: 'Nueva Entidad' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({
      code: 'ENT-002',
      name: 'Nueva Entidad',
    });
  });
});

describe('EntidadesService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    // Esparcir el DTO entero escribiría `undefined` sobre campos que nadie
    // quiso borrar.
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await service.update('ent-1', { email: 'nuevo@ejemplo.com' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({ email: 'nuevo@ejemplo.com' });
  });

  it('desactivar es una edición, no un borrado', async () => {
    // No hay endpoint de borrado: cada copropiedad que esta entidad
    // administró todavía tiene que poder resolver quién lo hizo.
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    const resultado = await service.update('ent-1', { estado: 'inactivo' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({ status: 'inactive' });
    expect(resultado.estado).toBe('activo'); // el doc devuelto por el stub
  });

  it('no choca consigo misma al guardar sin cambiar el código', async () => {
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await service.update('ent-1', { codigo: 'ENT-001' }, ACTOR);

    expect(modelo.filtros[0]).toEqual({
      code: 'ENT-001',
      _id: { $ne: 'ent-1' },
    });
  });

  it('responde "no existe" cuando el id no corresponde a ninguna', async () => {
    const modelo = modeloCon([documento()]);
    modelo.findByIdAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new EntidadesService(modelo as never, mockAuditoria() as never);

    await expect(
      service.update('ent-ajena', { email: 'x@x.com' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
