import { ConflictException, NotFoundException } from '@nestjs/common';
import { CopropiedadesService } from './copropiedades.service';

type Filtro = Record<string, unknown>;

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'cop-1' },
  code: 'COP-001',
  name: 'Terrazas de Granada',
  taxId: null,
  taxIdVerificationDigit: null,
  address: null,
  city: null,
  phone: null,
  email: null,
  managingEntityId: null,
  administratorName: null,
  status: 'active',
  usesBuildingManagement: false,
  ...over,
});

const modeloCon = (filas: unknown[], opts: { duplicado?: boolean } = {}) => {
  const filtros: Filtro[] = [];
  const escrituras: Record<string, unknown>[] = [];
  const cadenaLista = {
    populate: () => cadenaLista,
    sort: () => cadenaLista,
    skip: () => cadenaLista,
    limit: () => cadenaLista,
    exec: () => Promise.resolve(filas),
  };

  return {
    filtros,
    escrituras,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadenaLista;
    }),
    findById: jest.fn(() => ({
      populate: () => ({ exec: () => Promise.resolve(filas[0] ?? null) }),
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

describe('CopropiedadesService.findAll', () => {
  it('no requiere copropiedad activa: es el catálogo de tenants, no un tenant', async () => {
    // A diferencia de Inmuebles, este servicio no depende de
    // TenantContextService en absoluto — hay que poder listar todas las
    // copropiedades sin haber elegido ninguna.
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await expect(service.findAll({})).resolves.toBeDefined();
  });

  it('devuelve el nombre de la entidad administradora cuando la trae poblada', async () => {
    const modelo = modeloCon([
      documento({
        managingEntityId: { _id: { toString: () => 'ent-1' }, name: 'Calad' },
      }),
    ]);
    const service = new CopropiedadesService(modelo as never);

    const { items } = await service.findAll({});

    expect(items[0].entidadAdministradora).toEqual({
      id: 'ent-1',
      nombre: 'Calad',
    });
  });

  it('devuelve null cuando no hay entidad administradora en el archivo', async () => {
    const modelo = modeloCon([
      documento({ managingEntityId: null, administratorName: 'Portería' }),
    ]);
    const service = new CopropiedadesService(modelo as never);

    const { items } = await service.findAll({});

    expect(items[0].entidadAdministradora).toBeNull();
    expect(items[0].nombreAdministrador).toBe('Portería');
  });
});

describe('CopropiedadesService.create', () => {
  it('rechaza un código repetido', async () => {
    const modelo = modeloCon([], { duplicado: true });
    const service = new CopropiedadesService(modelo as never);

    await expect(
      service.create({ codigo: 'COP-001', nombre: 'Otra' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CopropiedadesService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { ciudad: 'Medellín' });

    expect(modelo.escrituras[0]).toEqual({ city: 'Medellín' });
  });

  it('nombrar una entidad administradora borra la nota interna', async () => {
    // Un edificio tiene una empresa administradora en el archivo o no la
    // tiene, nunca un estado a medias — fijar una tiene que retirar la otra.
    // Ninguna de las dos dice quién administra en la práctica: eso es
    // siempre una persona, asignada en Usuarios.
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { entidadAdministradoraId: 'ent-9' });

    expect(modelo.escrituras[0]).toEqual({
      managingEntityId: 'ent-9',
      administratorName: null,
    });
  });

  it('escribir la nota interna desvincula la entidad', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { nombreAdministrador: 'Portería' });

    expect(modelo.escrituras[0]).toEqual({
      administratorName: 'Portería',
      managingEntityId: null,
    });
  });

  it('desactivar es una edición, no un borrado', async () => {
    // Nada elimina una copropiedad: sus facturas y recibos tienen que seguir
    // siendo legibles para siempre.
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { estado: 'inactivo' });

    expect(modelo.escrituras[0]).toEqual({ status: 'inactive' });
  });

  it('no choca consigo misma al guardar sin cambiar el código', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { codigo: 'COP-001' });

    expect(modelo.filtros[0]).toEqual({
      code: 'COP-001',
      _id: { $ne: 'cop-1' },
    });
  });

  it('responde "no existe" cuando el id no corresponde a ninguna', async () => {
    const modelo = modeloCon([documento()]);
    modelo.findByIdAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new CopropiedadesService(modelo as never);

    await expect(
      service.update('cop-ajena', { ciudad: 'Cali' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('guarda la cuenta contable de cartera cuando viene', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { cuentaContableCartera: '130501' });

    expect(modelo.escrituras[0]).toEqual({
      receivablesAccount: '130501',
    });
  });

  it('guarda la cuenta de anticipos cuando viene', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { cuentaAnticipos: '210505' });

    expect(modelo.escrituras[0]).toEqual({
      advancesAccount: '210505',
    });
  });

  it('guarda la cuenta de devoluciones cuando viene', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(modelo as never);

    await service.update('cop-1', { cuentaDevoluciones: '413595' });

    expect(modelo.escrituras[0]).toEqual({
      creditNotesAccount: '413595',
    });
  });
});
