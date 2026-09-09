import { NotFoundException } from '@nestjs/common';
import { EntidadesService } from './entidades.service';

type Filtro = Record<string, unknown>;

const mockAuditoria = () => ({
  registrar: jest.fn().mockResolvedValue(undefined),
});

/** Mimics the atomic counter: each call returns the next integer. */
const mockContador = (valorInicial = 0) => {
  let valor = valorInicial;
  return {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(valor > 0 ? { valor } : null),
    })),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve(undefined) })),
    findOneAndUpdate: jest.fn(() => ({
      exec: () => Promise.resolve({ valor: ++valor }),
    })),
  };
};

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
const modeloCon = (filas: unknown[]) => {
  const filtros: Filtro[] = [];
  const escrituras: Record<string, unknown>[] = [];
  const cadena = {
    sort: () => cadena,
    skip: () => cadena,
    limit: () => cadena,
    collation: () => cadena,
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
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    return service.findAll({}).then(() => {
      expect(modelo.filtros[0]).not.toHaveProperty('coPropertyId');
    });
  });

  it('busca por código o por nombre', async () => {
    const modelo = modeloCon([]);
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    await service.findAll({ buscar: 'Calad' });

    expect(modelo.filtros[0].$or).toEqual([
      { code: { $regex: 'Calad', $options: 'i' } },
      { name: { $regex: 'Calad', $options: 'i' } },
    ]);
  });

  it('muestra solo las activas por defecto', async () => {
    const modelo = modeloCon([]);
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    await service.findAll({});

    expect(modelo.filtros[0].status).toBe('active');
  });

  it('devuelve el contrato en español', async () => {
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

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
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    await expect(service.findOne('ent-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('EntidadesService.create', () => {
  it('asigna el código automáticamente desde el contador, incrementándolo de forma atómica', async () => {
    const modelo = modeloCon([]);
    const contador = mockContador(41);
    const service = new EntidadesService(
      modelo as never,
      contador as never,
      mockAuditoria() as never,
    );

    await service.create({ nombre: 'Nueva Entidad' }, ACTOR);

    expect(contador.findOneAndUpdate).toHaveBeenCalledWith(
      {},
      { $inc: { valor: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    expect(modelo.escrituras[0]).toEqual({
      code: '0042',
      name: 'Nueva Entidad',
    });
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const modelo = modeloCon([]);
    const auditoria = mockAuditoria();
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      auditoria as never,
    );

    await service.create({ nombre: 'Nueva Entidad' }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'crear',
      entidadTipo: 'entidad-administradora',
      entidadId: 'ent-1',
      entidadEtiqueta: 'Nueva Entidad',
    });
  });

  it('si falla la auditoría, la creación entera falla — nada queda sin rastro', async () => {
    const modelo = modeloCon([]);
    const auditoria = {
      registrar: jest.fn().mockRejectedValue(new Error('audit down')),
    };
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      auditoria as never,
    );

    await expect(
      service.create({ nombre: 'Nueva Entidad' }, ACTOR),
    ).rejects.toThrow('audit down');
  });
});

describe('EntidadesService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    // Esparcir el DTO entero escribiría `undefined` sobre campos que nadie
    // quiso borrar.
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    await service.update('ent-1', { email: 'nuevo@ejemplo.com' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({ email: 'nuevo@ejemplo.com' });
  });

  it('desactivar es una edición, no un borrado', async () => {
    // No hay endpoint de borrado: cada copropiedad que esta entidad
    // administró todavía tiene que poder resolver quién lo hizo.
    const modelo = modeloCon([documento()]);
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    const resultado = await service.update(
      'ent-1',
      { estado: 'inactivo' },
      ACTOR,
    );

    expect(modelo.escrituras[0]).toEqual({ status: 'inactive' });
    expect(resultado.estado).toBe('activo'); // el doc devuelto por el stub
  });

  it('responde "no existe" cuando el id no corresponde a ninguna', async () => {
    const modelo = modeloCon([documento()]);
    modelo.findByIdAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      mockAuditoria() as never,
    );

    await expect(
      service.update('ent-ajena', { email: 'x@x.com' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const modelo = modeloCon([documento()]);
    const auditoria = mockAuditoria();
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      auditoria as never,
    );

    await service.update('ent-1', { email: 'nuevo@ejemplo.com' }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'actualizar',
      entidadTipo: 'entidad-administradora',
      entidadId: 'ent-1',
      entidadEtiqueta: 'Administraciones Calad',
    });
  });

  it('si falla la auditoría, la actualización entera falla — nada queda sin rastro', async () => {
    const modelo = modeloCon([documento()]);
    const auditoria = {
      registrar: jest.fn().mockRejectedValue(new Error('audit down')),
    };
    const service = new EntidadesService(
      modelo as never,
      mockContador() as never,
      auditoria as never,
    );

    await expect(
      service.update('ent-1', { email: 'nuevo@ejemplo.com' }, ACTOR),
    ).rejects.toThrow('audit down');
  });
});
