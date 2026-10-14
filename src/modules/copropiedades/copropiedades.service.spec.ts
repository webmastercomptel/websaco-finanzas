import { BadRequestException, NotFoundException } from '@nestjs/common';
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

    it('acepta el id en mayúsculas', async () => {
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
        websaco3CopropiedadId: ID.toUpperCase(),
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
