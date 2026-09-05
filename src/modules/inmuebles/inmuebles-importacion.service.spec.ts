import { Types } from 'mongoose';
import { InmueblesService } from './inmuebles.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const fila = (over: Record<string, unknown> = {}) => ({
  codigo: '301',
  ...over,
});

/** Records every code checked and every unit written; codes in `existentes`
 *  are reported as already taken. */
const inmueblesModeloCon = (existentes: string[] = []) => {
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    exists: jest.fn(({ code }: Filtro) => ({
      exec: () =>
        Promise.resolve(
          existentes.includes(code as string) ? { _id: 'x' } : null,
        ),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve({ _id: { toString: () => 'inm-nuevo' } });
    }),
  };
};

/** `porIdentificacion` maps an existing party's identification to its id. */
const tercerosModeloCon = (porIdentificacion: Record<string, string> = {}) => {
  const creados: Record<string, unknown>[] = [];
  const actualizaciones: { id: string; cambios: Record<string, unknown> }[] =
    [];
  return {
    creados,
    actualizaciones,
    findOne: jest.fn(({ identificationNumber }: Filtro) => ({
      exec: () => {
        const id = porIdentificacion[identificationNumber as string];
        return Promise.resolve(id ? { _id: id } : null);
      },
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      creados.push(doc);
      return Promise.resolve({ _id: 'ter-nuevo' });
    }),
    updateOne: jest.fn(
      (
        { _id }: { _id: string },
        { $set }: { $set: Record<string, unknown> },
      ) => {
        actualizaciones.push({ id: _id, cambios: $set });
        return { exec: () => Promise.resolve({ modifiedCount: 1 }) };
      },
    ),
  };
};

const tenant = {
  resolveCoPropertyId: () => COP,
} as unknown as TenantContextService;

/** A small fixture standing in for the real DIAN/DANE static catalog. */
const catalogos = {
  listarTiposIdentificacion: jest.fn(() => [
    { codigo: '13', nombre: 'Cedula de Ciudadania' },
    { codigo: '31', nombre: 'Nit' },
  ]),
  listarCiudades: jest.fn(() => [
    { codigo: '05001', nombre: 'Medellin', departamentoCodigo: '05' },
    { codigo: '11001', nombre: 'Bogota D.C', departamentoCodigo: '11' },
  ]),
};

/** `eliminarTodosEliminables` — the wipe-before-import step. Defaults to
 *  "nothing to wipe" so every test not about the wipe itself is unaffected. */
const eliminacionModeloCon = (
  respuesta: { eliminados: number; bloqueados: string[] } = {
    eliminados: 0,
    bloqueados: [],
  },
) => ({
  eliminarTodosEliminables: jest.fn(() => Promise.resolve(respuesta)),
});

/** Records every `guardar` call — the DTO's `cargos` line, unchanged, is
 *  what a row's import must forward. */
const valoresRecurrentesModeloCon = () => {
  const llamadas: { inmuebleId: string; valores: unknown }[] = [];
  return {
    llamadas,
    guardar: jest.fn((inmuebleId: string, dto: { valores: unknown }) => {
      llamadas.push({ inmuebleId, valores: dto.valores });
      return Promise.resolve([]);
    }),
  };
};

describe('InmueblesService.importar', () => {
  it('crea cada fila como un inmueble, contando el total', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    const resultado = await service.importar({
      filas: [fila({ codigo: '301' }), fila({ codigo: '302' })],
    });

    expect(resultado).toEqual({
      total: 2,
      creados: 2,
      errores: [],
      eliminadosAntes: 0,
      bloqueadosPorFactura: [],
    });
    expect(inmuebles.escrituras).toHaveLength(2);
  });

  it('una fila con código repetido falla sola, sin abortar el resto', async () => {
    // Un archivo de 400 filas con tres typos no debería tener que
    // resubirse entero.
    const inmuebles = inmueblesModeloCon(['301']);
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    const resultado = await service.importar({
      filas: [fila({ codigo: '301' }), fila({ codigo: '302' })],
    });

    expect(resultado.creados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]).toMatchObject({ fila: 1, codigo: '301' });
    expect(resultado.errores[0].mensaje).toContain('301');
  });

  it('reutiliza un tercero existente por identificación, sin duplicarlo', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nombreTitular: 'Ana Pérez',
          numeroIdentificacionTitular: '123456',
        }),
      ],
    });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0]).toMatchObject({ holderId: 'ter-1' });
  });

  it('reimportar actualiza un titular ya existente con los datos de la fila, no lo deja intacto', async () => {
    // El borrado automático nunca toca Tercero (ver InmueblesEliminacionService),
    // así que la segunda vez que se importa el mismo edificio, cada titular
    // se reutiliza — pero eso no puede significar que quede pegado con datos
    // viejos si el archivo trae una ciudad o un tipo de documento nuevos.
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      catalogos as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nombreTitular: 'Ana Pérez',
          numeroIdentificacionTitular: '123456',
          tipoIdentificacionTitular: '13',
          ciudadTitular: '05001',
          direccionTitular: 'Calle 10 # 20-30',
        }),
      ],
    });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(terceros.actualizaciones).toHaveLength(1);
    expect(terceros.actualizaciones[0]).toEqual({
      id: 'ter-1',
      cambios: {
        personType: 'natural',
        name: 'Ana Pérez',
        identificationType: '13',
        address: 'Calle 10 # 20-30',
        city: 'Medellin',
        cityCode: '05001',
        cityDepartmentCode: '05',
      },
    });
  });

  it('reimportar sin nombre en la fila no borra el nombre ya guardado del titular', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          numeroIdentificacionTitular: '123456',
          telefonoTitular: '3000000000',
        }),
      ],
    });

    expect(terceros.actualizaciones).toHaveLength(1);
    expect(terceros.actualizaciones[0].cambios).toEqual({
      phone: '3000000000',
    });
  });

  it('crea un tercero nuevo cuando la identificación no coincide con ninguno', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [fila({ codigo: '301', nombreTitular: 'Ana Pérez' })],
    });

    expect(terceros.creados[0]).toMatchObject({
      coPropertyId: COP,
      name: 'Ana Pérez',
    });
    expect(inmuebles.escrituras[0]).toMatchObject({ holderId: 'ter-nuevo' });
  });

  it('concatena nom1Titular/ape1Titular en name para un titular persona natural', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nom1Titular: 'Ana',
          nom2Titular: 'María',
          ape1Titular: 'Pérez',
          ape2Titular: 'Gómez',
        }),
      ],
    });

    expect(terceros.creados[0]).toMatchObject({
      personType: 'natural',
      name: 'Ana María Pérez Gómez',
      firstName: 'Ana',
      middleName: 'María',
      firstLastName: 'Pérez',
      secondLastName: 'Gómez',
    });
  });

  it('usa razonSocialTitular para un titular persona jurídica', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [fila({ codigo: '301', razonSocialTitular: 'Ferretería SAS' })],
    });

    expect(terceros.creados[0]).toMatchObject({
      personType: 'juridica',
      name: 'Ferretería SAS',
      businessName: 'Ferretería SAS',
    });
  });

  it('deja el inmueble sin titular cuando la fila no trae ninguno: se carga antes que sus papeles', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0].holderId).toBeUndefined();
  });

  it('escribe siempre la copropiedad activa, nunca una de la fila', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(inmuebles.escrituras[0]).toMatchObject({ coPropertyId: COP });
  });

  it('guarda los cargos de la fila contra el inmueble recién creado', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );
    const cargos = [{ conceptoId: 'con-1', monto: 350000 }];

    await service.importar({ filas: [fila({ codigo: '301', cargos })] });

    expect(valoresRecurrentes.guardar).toHaveBeenCalledTimes(1);
    expect(valoresRecurrentes.llamadas[0]).toEqual({
      inmuebleId: 'inm-nuevo',
      valores: cargos,
    });
  });

  it('una fila sin cargos no llama a guardar los valores recurrentes', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(valoresRecurrentes.guardar).not.toHaveBeenCalled();
  });

  it('guarda la dirección del titular tal cual viene en la fila', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      catalogos as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          razonSocialTitular: 'Ferretería SAS',
          direccionTitular: 'Calle 10 # 20-30',
        }),
      ],
    });

    expect(terceros.creados[0]).toMatchObject({
      address: 'Calle 10 # 20-30',
    });
  });

  it('resuelve el código de ciudad a su nombre y el código de su departamento', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      catalogos as never,
      eliminacion as never,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          razonSocialTitular: 'Ferretería SAS',
          ciudadTitular: '05001',
        }),
      ],
    });

    expect(terceros.creados[0]).toMatchObject({
      city: 'Medellin',
      cityCode: '05001',
      cityDepartmentCode: '05',
    });
  });

  it('una fila con un código de ciudad inexistente falla sola, sin abortar el resto', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      catalogos as never,
      eliminacion as never,
    );

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          razonSocialTitular: 'Ferretería SAS',
          ciudadTitular: '99999',
        }),
      ],
    });

    expect(resultado.creados).toBe(0);
    expect(resultado.errores[0].mensaje).toContain('99999');
    expect(terceros.create).not.toHaveBeenCalled();
  });

  it('una fila con un código de tipo de identificación inexistente falla sola', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      catalogos as never,
      eliminacion as never,
    );

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          razonSocialTitular: 'Ferretería SAS',
          tipoIdentificacionTitular: 'CC',
        }),
      ],
    });

    expect(resultado.creados).toBe(0);
    expect(resultado.errores[0].mensaje).toContain('CC');
    expect(terceros.create).not.toHaveBeenCalled();
  });

  it('borra los inmuebles eliminables ANTES de crear la primera fila: cada import reemplaza el listado', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(eliminacion.eliminarTodosEliminables).toHaveBeenCalledTimes(1);
  });

  it('reporta cuántos inmuebles se borraron y cuáles quedaron por tener factura', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const valoresRecurrentes = valoresRecurrentesModeloCon();
    const eliminacion = eliminacionModeloCon({
      eliminados: 12,
      bloqueados: ['101', '203'],
    });
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
      valoresRecurrentes as never,
      {} as never,
      eliminacion as never,
    );

    const resultado = await service.importar({
      filas: [fila({ codigo: '301' })],
    });

    expect(resultado.eliminadosAntes).toBe(12);
    expect(resultado.bloqueadosPorFactura).toEqual(['101', '203']);
  });
});
