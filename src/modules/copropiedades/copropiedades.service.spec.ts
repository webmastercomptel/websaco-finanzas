import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
  BadGatewayException,
} from '@nestjs/common';
import { CopropiedadesService } from './copropiedades.service';

type Filtro = Record<string, unknown>;

const mockAuditoria = () => ({
  registrar: jest.fn().mockResolvedValue(undefined),
});

/** Mimics the atomic counter: each call returns the next integer. */
const mockContador = (valorInicial = 0) => {
  let valor = valorInicial;
  return {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve({ valor }) })),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve(undefined) })),
    findOneAndUpdate: jest.fn(() => ({
      exec: () => Promise.resolve({ valor: ++valor }),
    })),
  };
};

const mockConceptos = () => ({
  create: jest.fn().mockResolvedValue({}),
});

const mockConsecutivos = () => ({
  insertMany: jest.fn().mockResolvedValue([]),
  find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
});

const mockCuentasContables = () => ({
  find: jest.fn(() => ({
    exec: () => Promise.resolve([]),
    distinct: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  })),
  insertMany: jest.fn().mockResolvedValue([]),
});

const mockConceptosCobro = () => ({
  find: jest.fn(() => ({
    sort: () => ({ exec: () => Promise.resolve([]) }),
    distinct: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  })),
});

const mockComptable = (
  resultado: Record<string, unknown> = { tipo: 'ok', status: 200, datos: {} },
) => ({
  consultarEmpresa: jest.fn().mockResolvedValue(resultado),
});

const mockAsignaciones = (filas: Record<string, unknown>[] = []) => ({
  find: jest.fn(() => ({ exec: () => Promise.resolve(filas) })),
});

const mockAccounts = (filas: Record<string, unknown>[] = []) => ({
  find: jest.fn(() => ({ exec: () => Promise.resolve(filas) })),
});

const ACTOR = { accountId: 'actor-1', nombre: 'Admin Test' };

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'cop-1' },
  codigo: 'COP-001',
  nombre: 'Terrazas de Granada',
  nit: null,
  digitoVerificacion: null,
  direccion: null,
  ciudad: null,
  telefono: null,
  email: null,
  entidadId: null,
  nombreAdministrador: null,
  estado: 'active',
  usaGestionEdificios: false,
  mostrarLogo: true,
  ...over,
});

const modeloCon = (filas: unknown[], opts: { duplicado?: boolean } = {}) => {
  const filtros: Filtro[] = [];
  const escrituras: Record<string, unknown>[] = [];
  const selecciones: string[] = [];
  const cadenaLista = {
    populate: () => cadenaLista,
    sort: () => cadenaLista,
    skip: () => cadenaLista,
    limit: () => cadenaLista,
    collation: () => cadenaLista,
    exec: () => Promise.resolve(filas),
  };

  return {
    filtros,
    escrituras,
    selecciones,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadenaLista;
    }),
    findById: jest.fn(() => ({
      populate: () => ({ exec: () => Promise.resolve(filas[0] ?? null) }),
      exec: () => Promise.resolve(filas[0] ?? null),
      select: (campos: string) => {
        selecciones.push(campos);
        return {
          lean: () => ({ exec: () => Promise.resolve(filas[0] ?? null) }),
        };
      },
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
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await expect(service.findAll({})).resolves.toBeDefined();
  });

  it('devuelve el nombre de la entidad administradora cuando la trae poblada', async () => {
    const modelo = modeloCon([
      documento({
        entidadId: { _id: { toString: () => 'ent-1' }, nombre: 'Calad' },
      }),
    ]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    const { items } = await service.findAll({});

    expect(items[0].entidadAdministradora).toEqual({
      id: 'ent-1',
      nombre: 'Calad',
    });
  });

  it('devuelve null cuando no hay entidad administradora en el archivo', async () => {
    const modelo = modeloCon([
      documento({ entidadId: null, nombreAdministrador: 'Portería' }),
    ]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    const { items } = await service.findAll({});

    expect(items[0].entidadAdministradora).toBeNull();
    expect(items[0].nombreAdministrador).toBe('Portería');
  });

  it('sin entidad, usa el nombre de la cuenta con Asignación activa a la copropiedad', async () => {
    const modelo = modeloCon([documento({ entidadId: null })]);
    const asignaciones = mockAsignaciones([
      {
        accountId: { toString: () => 'acc-1' },
        copropiedadId: { toString: () => 'cop-1' },
      },
    ]);
    const accounts = mockAccounts([
      { _id: { toString: () => 'acc-1' }, nombreCompleto: 'Juana Restrepo' },
    ]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      asignaciones as never,
      accounts as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    const { items } = await service.findAll({});

    expect(items[0].usuarioAdministrador).toBe('Juana Restrepo');
  });

  it('junta los nombres cuando hay más de una cuenta asignada', async () => {
    const modelo = modeloCon([documento({ entidadId: null })]);
    const asignaciones = mockAsignaciones([
      {
        accountId: { toString: () => 'acc-1' },
        copropiedadId: { toString: () => 'cop-1' },
      },
      {
        accountId: { toString: () => 'acc-2' },
        copropiedadId: { toString: () => 'cop-1' },
      },
    ]);
    const accounts = mockAccounts([
      { _id: { toString: () => 'acc-1' }, nombreCompleto: 'Juana Restrepo' },
      { _id: { toString: () => 'acc-2' }, nombreCompleto: 'Carlos Vega' },
    ]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      asignaciones as never,
      accounts as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    const { items } = await service.findAll({});

    expect(items[0].usuarioAdministrador).toBe('Juana Restrepo, Carlos Vega');
  });

  it('con entidad administradora, no consulta Asignaciones — el grant es por la entidad', async () => {
    const modelo = modeloCon([
      documento({
        entidadId: { _id: { toString: () => 'ent-1' }, nombre: 'Calad' },
      }),
    ]);
    const asignaciones = mockAsignaciones();
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      asignaciones as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    const { items } = await service.findAll({});

    expect(asignaciones.find).not.toHaveBeenCalled();
    expect(items[0].usuarioAdministrador).toBeNull();
  });

  it('sin ninguna Asignación activa, usuarioAdministrador queda null', async () => {
    const modelo = modeloCon([documento({ entidadId: null })]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    const { items } = await service.findAll({});

    expect(items[0].usuarioAdministrador).toBeNull();
  });
});

describe('CopropiedadesService.create', () => {
  it('asigna el código automáticamente desde el contador', async () => {
    const modelo = modeloCon([documento({ nombre: 'Nueva Copro' })]);
    const contador = mockContador(9);
    const service = new CopropiedadesService(
      modelo as never,
      contador as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.create({ nombre: 'Nueva Copro' }, ACTOR);

    expect(modelo.escrituras[0]).toMatchObject({ codigo: '0010' });
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    // findById(0)-tras-create necesita una fila para el re-lectura poblada
    // que create() hace al final; el nombre viene de ahí, no de `escrituras`.
    const modelo = modeloCon([documento({ nombre: 'Nueva Copro' })]);
    const auditoria = mockAuditoria();
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      auditoria as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.create({ nombre: 'Nueva Copro' }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'crear',
      entidadTipo: 'copropiedad',
      entidadId: 'cop-1',
      entidadEtiqueta: 'Nueva Copro',
    });
  });

  it('si falla la auditoría, la creación entera falla — nada queda sin rastro', async () => {
    const modelo = modeloCon([documento()]);
    const auditoria = {
      registrar: jest.fn().mockRejectedValue(new Error('audit down')),
    };
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      auditoria as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await expect(
      service.create({ nombre: 'Nueva Copro' }, ACTOR),
    ).rejects.toThrow('audit down');
  });
});

describe('CopropiedadesService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { ciudad: 'Medellín' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({ ciudad: 'Medellín' });
  });

  it('permite apagar el logo de WebSACO en los documentos de esta copropiedad', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { mostrarLogo: false }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({ mostrarLogo: false });
  });

  it('nombrar una entidad administradora borra la nota interna', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { entidadAdministradoraId: 'ent-9' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({
      entidadId: 'ent-9',
      nombreAdministrador: null,
    });
  });

  it('escribir la nota interna desvincula la entidad', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { nombreAdministrador: 'Portería' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({
      nombreAdministrador: 'Portería',
      entidadId: null,
    });
  });

  it('desactivar es una edición, no un borrado', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { estado: 'inactivo' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({ estado: 'inactive' });
  });

  it('responde "no existe" cuando el id no corresponde a ninguna', async () => {
    const modelo = modeloCon([documento()]);
    modelo.findByIdAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await expect(
      service.update('cop-ajena', { ciudad: 'Cali' }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('registra la auditoría con el actor autenticado, nunca uno del body', async () => {
    const modelo = modeloCon([documento()]);
    const auditoria = mockAuditoria();
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      auditoria as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { ciudad: 'Medellín' }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: ACTOR.accountId,
      actorNombre: ACTOR.nombre,
      accion: 'actualizar',
      entidadTipo: 'copropiedad',
      entidadId: 'cop-1',
      entidadEtiqueta: 'Terrazas de Granada',
    });
  });

  it('si falla la auditoría, la actualización entera falla — nada queda sin rastro', async () => {
    const modelo = modeloCon([documento()]);
    const auditoria = {
      registrar: jest.fn().mockRejectedValue(new Error('audit down')),
    };
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      auditoria as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await expect(
      service.update('cop-1', { ciudad: 'Medellín' }, ACTOR),
    ).rejects.toThrow('audit down');
  });

  it('guarda la cuenta contable de cartera cuando viene', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { cuentaContableCartera: '130501' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({
      cuentaContableCartera: '130501',
    });
  });

  it('guarda la cuenta de anticipos cuando viene', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { cuentaAnticipos: '210505' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({
      cuentaAnticipos: '210505',
    });
  });

  it('guarda la cuenta de devoluciones cuando viene', async () => {
    const modelo = modeloCon([documento()]);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );

    await service.update('cop-1', { cuentaDevoluciones: '413595' }, ACTOR);

    expect(modelo.escrituras[0]).toEqual({
      cuentaDevoluciones: '413595',
    });
  });
});

// spec `building-management-activation` → "WebSaco3 coproperty id required on
// activation" and "Id is cleared when the flag is turned off".
describe('CopropiedadesService — aplicarReglaGestionEdificios', () => {
  const ID = '64b7f0c2a1d4e5f6a7b8c9d0';

  const construirService = (documentos: unknown[]) => {
    const modelo = modeloCon(documentos);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );
    return { modelo, service };
  };

  describe('activación', () => {
    it('crear con el flag en true y un id válido, sin NIT: acepta', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.create(
        {
          nombre: 'X',
          usaGestionEdificios: true,
          websaco3CopropiedadId: ID,
        },
        ACTOR,
      );

      expect(modelo.escrituras[0]).toMatchObject({
        usaGestionEdificios: true,
        websaco3CopropiedadId: ID,
      });
    });

    it('crear con el flag en true y sin id: rechaza', async () => {
      const { service } = construirService([documento()]);

      await expect(
        service.create({ nombre: 'X', usaGestionEdificios: true }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('crear con el flag en true y un NIT completo pero sin id: rechaza — el NIT ya no habilita', async () => {
      const { service } = construirService([documento()]);

      await expect(
        service.create(
          {
            nombre: 'X',
            usaGestionEdificios: true,
            nit: '900123456',
            digitoVerificacion: '7',
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('el servicio revalida el formato aunque el DTO ya lo haya hecho', async () => {
      const { service } = construirService([documento()]);

      await expect(
        service.create(
          {
            nombre: 'X',
            usaGestionEdificios: true,
            websaco3CopropiedadId: 'zzzzzzzzzzzzzzzzzzzzzzzz',
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['con prefijo 0x', `0x${'a'.repeat(22)}`],
      ['con prefijo 0h', `0h${'a'.repeat(22)}`],
      ['de 23 caracteres', ID.slice(0, 23)],
      ['de 25 caracteres', `${ID}0`],
    ])('rechaza un id %s', async (_caso, id) => {
      const { service } = construirService([documento()]);

      await expect(
        service.create(
          { nombre: 'X', usaGestionEdificios: true, websaco3CopropiedadId: id },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Changed on purpose (spec `copropiedad-websaco3-link`: the service MUST
    // normalize with trim + lowercase before comparing OR storing). It used to
    // assert the uppercase value reached the model untouched.
    it('acepta el id en mayúsculas y lo guarda normalizado en minúsculas', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.create(
        {
          nombre: 'X',
          usaGestionEdificios: true,
          websaco3CopropiedadId: ID.toUpperCase(),
        },
        ACTOR,
      );

      expect(modelo.escrituras[0]).toMatchObject({
        websaco3CopropiedadId: ID,
      });
    });

    it('actualizar activa el flag y manda el id en el mismo request: acepta', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.update(
        'cop-1',
        { usaGestionEdificios: true, websaco3CopropiedadId: ID },
        ACTOR,
      );

      expect(modelo.escrituras[0]).toEqual({
        usaGestionEdificios: true,
        websaco3CopropiedadId: ID,
      });
    });

    it('actualizar activa el flag y reutiliza el id ya guardado', async () => {
      const { modelo, service } = construirService([
        documento({ usaGestionEdificios: false, websaco3CopropiedadId: ID }),
      ]);

      await service.update('cop-1', { usaGestionEdificios: true }, ACTOR);

      expect(modelo.escrituras[0]).toEqual({ usaGestionEdificios: true });
    });

    it('actualizar activa el flag sin id en ningún lado: rechaza', async () => {
      const { service } = construirService([
        documento({ usaGestionEdificios: false, websaco3CopropiedadId: null }),
      ]);

      await expect(
        service.update('cop-1', { usaGestionEdificios: true }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un documento legacy (sin la clave) con el flag apagado tampoco puede activarse sin id', async () => {
      const { service } = construirService([
        documento({ usaGestionEdificios: false }),
      ]);

      await expect(
        service.update('cop-1', { usaGestionEdificios: true }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('actualizar sin tocar flag ni id: acepta — la regla no corre (ni con el flag en true y sin id)', async () => {
      // Fixture deliberada: un estado legacy real (flag en true, sin id). Si
      // la regla corriera por error, esta fila la rechazaría; que el update
      // pase demuestra que NO se ejecuta, no que pasaría de todos modos.
      const { modelo, service } = construirService([
        documento({ usaGestionEdificios: true, websaco3CopropiedadId: null }),
      ]);

      await service.update('cop-1', { ciudad: 'Cali' }, ACTOR);

      expect(modelo.escrituras[0]).toEqual({ ciudad: 'Cali' });
    });

    it('corregir el id con el flag en true: acepta y escribe el nuevo', async () => {
      const otro = 'aaaaaaaaaaaaaaaaaaaaaaaa';
      const { modelo, service } = construirService([
        documento({ usaGestionEdificios: true, websaco3CopropiedadId: ID }),
      ]);

      await service.update('cop-1', { websaco3CopropiedadId: otro }, ACTOR);

      expect(modelo.escrituras[0]).toEqual({ websaco3CopropiedadId: otro });
    });

    it('un NIT incompleto ya no bloquea la activación ni la edición', async () => {
      const { modelo, service } = construirService([
        documento({
          usaGestionEdificios: true,
          websaco3CopropiedadId: ID,
          nit: null,
          digitoVerificacion: null,
        }),
      ]);

      await service.update('cop-1', { nit: '900123456' }, ACTOR);

      expect(modelo.escrituras[0]).toEqual({ nit: '900123456' });
    });

    it('update lee del documento guardado tanto el flag como el id', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.update('cop-1', { usaGestionEdificios: false }, ACTOR);

      expect(modelo.selecciones[0]).toContain('usaGestionEdificios');
      expect(modelo.selecciones[0]).toContain('websaco3CopropiedadId');
    });
  });

  describe('flag apagado', () => {
    it('desactivar limpia el id guardado', async () => {
      const { modelo, service } = construirService([
        documento({ usaGestionEdificios: true, websaco3CopropiedadId: ID }),
      ]);

      await service.update('cop-1', { usaGestionEdificios: false }, ACTOR);

      expect(modelo.escrituras[0]).toEqual({
        usaGestionEdificios: false,
        websaco3CopropiedadId: null,
      });
    });

    it('un id enviado con el flag apagado se descarta y el request se acepta', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.update(
        'cop-1',
        { usaGestionEdificios: false, websaco3CopropiedadId: ID },
        ACTOR,
      );

      expect(modelo.escrituras[0]).toEqual({
        usaGestionEdificios: false,
        websaco3CopropiedadId: null,
      });
    });

    it('un id enviado sin tocar el flag, que ya está apagado, se descarta', async () => {
      const { modelo, service } = construirService([
        documento({ usaGestionEdificios: false }),
      ]);

      await service.update('cop-1', { websaco3CopropiedadId: ID }, ACTOR);

      expect(modelo.escrituras[0]).toEqual({ websaco3CopropiedadId: null });
    });

    it('crear con el flag apagado y un id: lo descarta', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.create(
        {
          nombre: 'X',
          usaGestionEdificios: false,
          websaco3CopropiedadId: ID,
        },
        ACTOR,
      );

      expect(modelo.escrituras[0]).toMatchObject({
        usaGestionEdificios: false,
        websaco3CopropiedadId: null,
      });
    });
  });
});

// spec `copropiedad-websaco3-link` → "websaco3CopropiedadId is unique when set".
describe('CopropiedadesService — unicidad de websaco3CopropiedadId', () => {
  const ID = '64b7f0c2a1d4e5f6a7b8c9d0';

  const construirService = (
    documentos: unknown[],
    opts: { duplicado?: boolean } = {},
  ) => {
    const modelo = modeloCon(documentos, opts);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      mockComptable() as never,
    );
    return { modelo, service };
  };

  const errorDuplicado = (clave: string) =>
    Object.assign(new Error(`E11000 duplicate key error index: ${clave}_1`), {
      code: 11000,
      keyPattern: { [clave]: 1 },
    });

  describe('crear', () => {
    it('un id libre se acepta y se consulta sin excluir ninguna copropiedad', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.create(
        { nombre: 'X', usaGestionEdificios: true, websaco3CopropiedadId: ID },
        ACTOR,
      );

      expect(modelo.exists).toHaveBeenCalledWith({
        websaco3CopropiedadId: ID,
      });
      expect(modelo.escrituras[0]).toMatchObject({
        websaco3CopropiedadId: ID,
      });
    });

    it('un id ya usado responde 409 en español y no escribe nada', async () => {
      const { modelo, service } = construirService([documento()], {
        duplicado: true,
      });

      const intento = service.create(
        { nombre: 'X', usaGestionEdificios: true, websaco3CopropiedadId: ID },
        ACTOR,
      );

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(/ID de WebSaco3/);
      expect(modelo.create).not.toHaveBeenCalled();
    });

    it('la misma id en mayúsculas colisiona: se compara en minúsculas', async () => {
      const { modelo, service } = construirService([documento()], {
        duplicado: true,
      });

      await expect(
        service.create(
          {
            nombre: 'X',
            usaGestionEdificios: true,
            websaco3CopropiedadId: ID.toUpperCase(),
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(modelo.exists).toHaveBeenCalledWith({
        websaco3CopropiedadId: ID,
      });
    });

    it('sin id (flag apagado o no enviado) nunca consulta ni choca', async () => {
      const { modelo, service } = construirService([documento()], {
        duplicado: true,
      });

      await service.create({ nombre: 'X' }, ACTOR);
      await service.create(
        { nombre: 'Y', usaGestionEdificios: false, websaco3CopropiedadId: ID },
        ACTOR,
      );

      expect(modelo.exists).not.toHaveBeenCalled();
      expect(modelo.create).toHaveBeenCalledTimes(2);
    });

    it('una carrera: E11000 sobre websaco3CopropiedadId se traduce a 409, no a 500', async () => {
      const { modelo, service } = construirService([documento()]);
      modelo.create.mockRejectedValueOnce(
        errorDuplicado('websaco3CopropiedadId'),
      );

      await expect(
        service.create(
          { nombre: 'X', usaGestionEdificios: true, websaco3CopropiedadId: ID },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un E11000 sobre otra clave no se disfraza: se relanza tal cual', async () => {
      const { modelo, service } = construirService([documento()]);
      const original = errorDuplicado('codigo');
      modelo.create.mockRejectedValueOnce(original);

      await expect(
        service.create(
          { nombre: 'X', usaGestionEdificios: true, websaco3CopropiedadId: ID },
          ACTOR,
        ),
      ).rejects.toBe(original);
    });
  });

  describe('actualizar', () => {
    it('un id usado por OTRA copropiedad responde 409 y no escribe', async () => {
      const { modelo, service } = construirService([documento()], {
        duplicado: true,
      });

      await expect(
        service.update(
          'cop-1',
          { usaGestionEdificios: true, websaco3CopropiedadId: ID },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(modelo.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('la consulta excluye a la propia copropiedad: reenviar su id no choca consigo misma', async () => {
      const { modelo, service } = construirService([
        documento({ usaGestionEdificios: true, websaco3CopropiedadId: ID }),
      ]);

      await service.update('cop-1', { websaco3CopropiedadId: ID }, ACTOR);

      expect(modelo.exists).toHaveBeenCalledWith({
        websaco3CopropiedadId: ID,
        _id: { $ne: 'cop-1' },
      });
      expect(modelo.escrituras[0]).toEqual({ websaco3CopropiedadId: ID });
    });

    it('la variante en mayúsculas también choca y se guarda en minúsculas', async () => {
      const libre = construirService([documento()]);
      await libre.service.update(
        'cop-1',
        { usaGestionEdificios: true, websaco3CopropiedadId: ID.toUpperCase() },
        ACTOR,
      );
      expect(libre.modelo.exists).toHaveBeenCalledWith({
        websaco3CopropiedadId: ID,
        _id: { $ne: 'cop-1' },
      });
      expect(libre.modelo.escrituras[0]).toEqual({
        usaGestionEdificios: true,
        websaco3CopropiedadId: ID,
      });

      const ocupado = construirService([documento()], { duplicado: true });
      await expect(
        ocupado.service.update(
          'cop-1',
          {
            usaGestionEdificios: true,
            websaco3CopropiedadId: ID.toUpperCase(),
          },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('omitir el id (null contra null) no consulta ni choca aunque haya otras sin id', async () => {
      const { modelo, service } = construirService([documento()], {
        duplicado: true,
      });

      await service.update('cop-1', { ciudad: 'Cali' }, ACTOR);

      expect(modelo.exists).not.toHaveBeenCalled();
      expect(modelo.escrituras[0]).toEqual({ ciudad: 'Cali' });
    });

    it('apagar el flag limpia el id, no consulta y libera el id para otra copropiedad', async () => {
      const { modelo, service } = construirService(
        [documento({ usaGestionEdificios: true, websaco3CopropiedadId: ID })],
        { duplicado: true },
      );

      await service.update('cop-1', { usaGestionEdificios: false }, ACTOR);

      expect(modelo.exists).not.toHaveBeenCalled();
      expect(modelo.escrituras[0]).toEqual({
        usaGestionEdificios: false,
        websaco3CopropiedadId: null,
      });
    });

    it('una carrera: E11000 sobre websaco3CopropiedadId se traduce a 409, no a 500', async () => {
      const { modelo, service } = construirService([documento()]);
      modelo.findByIdAndUpdate.mockReturnValueOnce({
        exec: () => Promise.reject(errorDuplicado('websaco3CopropiedadId')),
      });

      await expect(
        service.update(
          'cop-1',
          { usaGestionEdificios: true, websaco3CopropiedadId: ID },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un E11000 sobre otra clave no se disfraza: se relanza tal cual', async () => {
      const { modelo, service } = construirService([documento()]);
      const original = errorDuplicado('codigo');
      modelo.findByIdAndUpdate.mockReturnValueOnce({
        exec: () => Promise.reject(original),
      });

      await expect(
        service.update('cop-1', { ciudad: 'Cali' }, ACTOR),
      ).rejects.toBe(original);
    });
  });
});

describe('CopropiedadesService — comptableEmpresaId', () => {
  const ID = '670000000000000000000001';

  const construirService = (
    documentos: unknown[],
    opts: {
      duplicado?: boolean;
      comptable?: Record<string, unknown>;
    } = {},
  ) => {
    const modelo = modeloCon(documentos, opts);
    const comptable = mockComptable(opts.comptable);
    const service = new CopropiedadesService(
      modelo as never,
      mockContador() as never,
      mockAsignaciones() as never,
      mockAccounts() as never,
      mockAuditoria() as never,
      mockConceptos() as never,
      mockConsecutivos() as never,
      mockCuentasContables() as never,
      mockConceptosCobro() as never,
      comptable as never,
    );
    return { modelo, service, comptable };
  };

  describe('crear', () => {
    it('una Empresa que existe en Comptable se valida y se guarda normalizada', async () => {
      const { modelo, service, comptable } = construirService([documento()]);

      await service.create(
        { nombre: 'X', comptableEmpresaId: ID.toUpperCase() },
        ACTOR,
      );

      expect(modelo.exists).toHaveBeenCalledWith({ comptableEmpresaId: ID });
      expect(comptable.consultarEmpresa).toHaveBeenCalledWith(ID);
      expect(modelo.escrituras[0]).toMatchObject({ comptableEmpresaId: ID });
    });

    it('sin Empresa no consulta a Comptable', async () => {
      const { service, comptable } = construirService([documento()]);

      await service.create({ nombre: 'X' }, ACTOR);

      expect(comptable.consultarEmpresa).not.toHaveBeenCalled();
    });

    it('formato inválido: 400 sin consultar a Comptable', async () => {
      const { modelo, service, comptable } = construirService([documento()]);

      await expect(
        service.create({ nombre: 'X', comptableEmpresaId: '0x1234' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(comptable.consultarEmpresa).not.toHaveBeenCalled();
      expect(modelo.create).not.toHaveBeenCalled();
    });

    it('una Empresa de otra copropiedad: 409 sin consultar a Comptable', async () => {
      const { modelo, service, comptable } = construirService([documento()], {
        duplicado: true,
      });

      const intento = service.create(
        { nombre: 'X', comptableEmpresaId: ID },
        ACTOR,
      );

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(/otra copropiedad/);
      expect(comptable.consultarEmpresa).not.toHaveBeenCalled();
      expect(modelo.create).not.toHaveBeenCalled();
    });

    it('Comptable dice que no existe: 422 "No existe esa Empresa en Comptable" y nada se guarda', async () => {
      const { modelo, service } = construirService([documento()], {
        comptable: { tipo: 'noEncontrado', mensaje: null },
      });

      const intento = service.create(
        { nombre: 'X', comptableEmpresaId: ID },
        ACTOR,
      );

      await expect(intento).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      await expect(intento).rejects.toThrow(
        'No existe esa Empresa en Comptable.',
      );
      expect(modelo.create).not.toHaveBeenCalled();
    });

    it.each([
      [
        'inalcanzable (timeout)',
        { tipo: 'timeout' },
        /comunicar con Comptable/,
      ],
      ['sin red', { tipo: 'red' }, /comunicar con Comptable/],
      ['con error 5xx', { tipo: 'inesperado', status: 503 }, /comunicar/],
      ['no configurado', { tipo: 'noConfigurado' }, /no está configurada/],
      ['rechazando la firma', { tipo: 'firma' }, /COMPTABLE_HMAC_SECRET/],
    ])(
      'Comptable %s: 502 y nada se guarda',
      async (_caso, resultado, mensaje) => {
        const { modelo, service } = construirService([documento()], {
          comptable: resultado,
        });

        const intento = service.create(
          { nombre: 'X', comptableEmpresaId: ID },
          ACTOR,
        );

        await expect(intento).rejects.toBeInstanceOf(BadGatewayException);
        await expect(intento).rejects.toThrow(mensaje);
        expect(modelo.create).not.toHaveBeenCalled();
      },
    );

    it('una carrera: E11000 sobre comptableEmpresaId se traduce a 409', async () => {
      const { modelo, service } = construirService([documento()]);
      modelo.create.mockRejectedValueOnce(
        Object.assign(new Error('E11000 comptableEmpresaId_1'), {
          code: 11000,
          keyPattern: { comptableEmpresaId: 1 },
        }),
      );

      await expect(
        service.create({ nombre: 'X', comptableEmpresaId: ID }, ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('actualizar', () => {
    it('solo valida cuando el valor cambia: reenviar la Empresa guardada no consulta nada', async () => {
      const { modelo, service, comptable } = construirService(
        [documento({ comptableEmpresaId: ID })],
        { duplicado: true },
      );

      await service.update(
        'cop-1',
        { comptableEmpresaId: ID.toUpperCase() },
        ACTOR,
      );

      expect(modelo.exists).not.toHaveBeenCalled();
      expect(comptable.consultarEmpresa).not.toHaveBeenCalled();
      expect(modelo.escrituras[0]).toEqual({ comptableEmpresaId: ID });
    });

    it('una edición que no toca la Empresa no depende de Comptable', async () => {
      const { service, comptable } = construirService(
        [documento({ comptableEmpresaId: ID })],
        { comptable: { tipo: 'timeout' } },
      );

      await service.update('cop-1', { ciudad: 'Cali' }, ACTOR);

      expect(comptable.consultarEmpresa).not.toHaveBeenCalled();
    });

    it('null desvincula sin consultar a Comptable', async () => {
      const { modelo, service, comptable } = construirService([
        documento({ comptableEmpresaId: ID }),
      ]);

      await service.update('cop-1', { comptableEmpresaId: null }, ACTOR);

      expect(comptable.consultarEmpresa).not.toHaveBeenCalled();
      expect(modelo.escrituras[0]).toEqual({ comptableEmpresaId: null });
    });

    it('cambiar de Empresa excluye a la propia copropiedad y valida contra Comptable', async () => {
      const otra = '670000000000000000000002';
      const { modelo, service, comptable } = construirService([
        documento({ comptableEmpresaId: ID }),
      ]);

      await service.update('cop-1', { comptableEmpresaId: otra }, ACTOR);

      expect(modelo.exists).toHaveBeenCalledWith({
        comptableEmpresaId: otra,
        _id: { $ne: 'cop-1' },
      });
      expect(comptable.consultarEmpresa).toHaveBeenCalledWith(otra);
      expect(modelo.escrituras[0]).toEqual({ comptableEmpresaId: otra });
    });

    it('Comptable caído al cambiar la Empresa: 502 y no escribe', async () => {
      const { modelo, service } = construirService([documento()], {
        comptable: { tipo: 'red' },
      });

      await expect(
        service.update('cop-1', { comptableEmpresaId: ID }, ACTOR),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(modelo.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it('update lee del documento guardado la Empresa actual', async () => {
      const { modelo, service } = construirService([documento()]);

      await service.update('cop-1', { ciudad: 'Cali' }, ACTOR);

      expect(modelo.selecciones[0]).toContain('comptableEmpresaId');
    });
  });
});
