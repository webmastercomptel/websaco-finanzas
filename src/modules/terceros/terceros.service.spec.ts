import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { TercerosService } from './terceros.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'ter-1' },
  personType: 'natural',
  name: 'Ana Pérez',
  identificationType: 'CC',
  identificationNumber: '123456',
  identificationVerificationDigit: null,
  emails: [],
  phone: null,
  address: null,
  city: null,
  einvoiceIdentificationType: null,
  einvoiceIdentificationNumber: null,
  einvoiceVerificationDigit: null,
  ciiuCode: null,
  salesRegime: null,
  fiscalResponsibilities: [],
  withholdsIncomeTax: false,
  withholdsLocalTax: false,
  status: 'active',
  ...over,
});

/** Chainable stub; records every filter and write it was called with. */
const modeloCon = (
  filas: unknown[],
  opts: { total?: number; duplicado?: boolean } = {},
) => {
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
    findOne: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(filas[0] ?? null) };
    }),
    countDocuments: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(opts.total ?? filas.length) };
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
    findOneAndUpdate: jest.fn(
      (_filtro: Filtro, update: Record<string, unknown>) => {
        escrituras.push((update as { $set: Record<string, unknown> }).$set);
        return { exec: () => Promise.resolve(filas[0] ? documento() : null) };
      },
    ),
  };
};

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

describe('TercerosService.findAll', () => {
  it('filtra SIEMPRE por la copropiedad activa', async () => {
    const modelo = modeloCon([documento()]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findAll({});

    for (const filtro of modelo.filtros) {
      expect(filtro.coPropertyId).toBe(COP);
    }
  });

  it('falla cerrado cuando no hay copropiedad activa', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(null),
    );

    await expect(service.findAll({})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(modelo.find).not.toHaveBeenCalled();
  });

  it('busca por nombre o por identificación', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findAll({ buscar: 'Pérez' });

    expect(modelo.filtros[0].$or).toEqual([
      { name: { $regex: 'Pérez', $options: 'i' } },
      { identificationNumber: { $regex: 'Pérez', $options: 'i' } },
    ]);
  });

  it('muestra solo los activos por defecto', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findAll({});

    expect(modelo.filtros[0].status).toBe('active');
  });

  it('devuelve el contrato en español', async () => {
    const modelo = modeloCon([documento()]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    const { items } = await service.findAll({});

    expect(items[0]).toMatchObject({
      nombre: 'Ana Pérez',
      tipoPersona: 'natural',
      numeroIdentificacion: '123456',
      estado: 'activo',
    });
  });
});

describe('TercerosService.findOne', () => {
  it('busca por id Y copropiedad en la misma consulta', async () => {
    const modelo = modeloCon([documento()]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findOne('ter-1');

    expect(modelo.filtros[0]).toEqual({ _id: 'ter-1', coPropertyId: COP });
  });

  it('responde "no existe" para un tercero de otra copropiedad', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(service.findOne('ter-ajeno')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('TercerosService.create', () => {
  it('rechaza una identificación repetida en la misma copropiedad', async () => {
    const modelo = modeloCon([], { duplicado: true });
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(
      service.create({
        tipoPersona: 'natural',
        nombre: 'Otro',
        numeroIdentificacion: '123456',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('no exige unicidad cuando no viene identificación: el edificio se carga antes que sus papeles', async () => {
    const modelo = modeloCon([], { duplicado: true });
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.create({ tipoPersona: 'natural', nombre: 'Sin papeles' });

    expect(modelo.exists).not.toHaveBeenCalled();
  });

  it('escribe la copropiedad activa, nunca una del cuerpo', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.create({ tipoPersona: 'juridica', nombre: 'Ferretería SAS' });

    expect(modelo.escrituras[0]).toMatchObject({
      coPropertyId: COP,
      personType: 'juridica',
      name: 'Ferretería SAS',
    });
  });

  it('persona natural: concatena nom1+nom2+ape1+ape2 en name, ignorando un nombre explícito', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.create({
      tipoPersona: 'natural',
      nombre: 'esto se descarta',
      nom1: 'Ana',
      nom2: 'María',
      ape1: 'Pérez',
      ape2: 'Gómez',
    });

    expect(modelo.escrituras[0]).toMatchObject({
      name: 'Ana María Pérez Gómez',
      firstName: 'Ana',
      middleName: 'María',
      firstLastName: 'Pérez',
      secondLastName: 'Gómez',
    });
  });

  it('persona natural: nom2/ape2 son opcionales, solo nom1+ape1 son obligatorios', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.create({
      tipoPersona: 'natural',
      nom1: 'Luis',
      ape1: 'Ruiz',
    });

    expect(modelo.escrituras[0]).toMatchObject({ name: 'Luis Ruiz' });
  });

  it('persona jurídica: razonSocial pasa a name, ignorando un nombre explícito', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.create({
      tipoPersona: 'juridica',
      nombre: 'esto se descarta',
      razonSocial: 'Inversiones ABC S.A.S.',
    });

    expect(modelo.escrituras[0]).toMatchObject({
      name: 'Inversiones ABC S.A.S.',
      businessName: 'Inversiones ABC S.A.S.',
    });
  });

  it('sin nom1+ape1 ni razonSocial, usa nombre como respaldo (ej. importación masiva)', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.create({ tipoPersona: 'natural', nombre: 'Carga de Excel' });

    expect(modelo.escrituras[0]).toMatchObject({ name: 'Carga de Excel' });
  });

  it('rechaza crear persona natural sin nom1+ape1 ni nombre', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(
      service.create({ tipoPersona: 'natural' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza crear persona jurídica sin razonSocial ni nombre', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(
      service.create({ tipoPersona: 'juridica' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TercerosService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    const modelo = modeloCon([documento()]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.update('ter-1', { emails: ['nuevo@ejemplo.com'] });

    expect(modelo.escrituras[0]).toEqual({ emails: ['nuevo@ejemplo.com'] });
  });

  it('no choca consigo mismo al guardar sin cambiar la identificación', async () => {
    const modelo = modeloCon([documento()]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.update('ter-1', { numeroIdentificacion: '123456' });

    expect(modelo.filtros[0]).toEqual({
      coPropertyId: COP,
      identificationNumber: '123456',
      _id: { $ne: 'ter-1' },
    });
  });

  it('responde "no existe" cuando el id no corresponde a esta copropiedad', async () => {
    const modelo = modeloCon([]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(
      service.update('ter-ajeno', { emails: ['x@x.com'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('editar solo ape2 recalcula name mezclado con nom1/nom2/ape1 ya guardados', async () => {
    const modelo = modeloCon([
      documento({
        name: 'Ana Pérez',
        firstName: 'Ana',
        middleName: null,
        firstLastName: 'Pérez',
        secondLastName: null,
      }),
    ]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.update('ter-1', { ape2: 'Gómez' });

    expect(modelo.escrituras[0]).toMatchObject({
      secondLastName: 'Gómez',
      name: 'Ana Pérez Gómez',
    });
  });

  it('no toca name cuando el patch no cambia ningún campo del nombre', async () => {
    const modelo = modeloCon([documento()]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.update('ter-1', { ciudad: 'Bogotá' });

    expect(modelo.escrituras[0]).toEqual({ city: 'Bogotá' });
  });

  it('editar solo la razón social conserva el resto del registro y no exige volver a enviarla toda', async () => {
    const modelo = modeloCon([
      documento({
        personType: 'juridica',
        name: 'Ferretería SAS',
        businessName: 'Ferretería SAS',
      }),
    ]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.update('ter-1', { razonSocial: 'Ferretería y Cía SAS' });

    expect(modelo.escrituras[0]).toMatchObject({
      businessName: 'Ferretería y Cía SAS',
      name: 'Ferretería y Cía SAS',
    });
  });

  it('rechaza borrar el nombre por completo al editar: limpiar razonSocial y nombre a la vez', async () => {
    const modelo = modeloCon([
      documento({
        personType: 'juridica',
        name: 'Ferretería SAS',
        businessName: 'Ferretería SAS',
      }),
    ]);
    const service = new TercerosService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(
      service.update('ter-1', { razonSocial: '', nombre: '' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
