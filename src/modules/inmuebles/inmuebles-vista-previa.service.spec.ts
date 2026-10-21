import { Types } from 'mongoose';
import { InmueblesService } from './inmuebles.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();
const CODIGO_COPROPIEDAD = '0001';

type Filtro = Record<string, unknown>;

const fila = (over: Record<string, unknown> = {}) => ({
  codigo: '301',
  codigoCopropiedad: CODIGO_COPROPIEDAD,
  ...over,
});

interface Unidad {
  id: string;
  codigo: string;
  estado?: 'active' | 'inactive';
  titularId?: string | null;
}

/** Every method that could write or delete, on every mocked model. */
const METODOS_DE_ESCRITURA = [
  'create',
  'insertMany',
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;

const inmueblesModeloCon = (
  unidades: Unidad[] = [],
  titularesCompartidos: string[] = [],
) => {
  const filtrosFind: Filtro[] = [];
  const filtrosExists: Filtro[] = [];
  const escritura = () => jest.fn();
  return {
    filtrosFind,
    filtrosExists,
    find: jest.fn((filtro: Filtro) => {
      filtrosFind.push(filtro);
      const cadena = {
        select: () => cadena,
        sort: () => cadena,
        lean: () => cadena,
        exec: () =>
          Promise.resolve(
            unidades.map((u) => ({
              _id: u.id,
              codigo: u.codigo,
              estado: u.estado ?? 'active',
              titularId: u.titularId ?? null,
            })),
          ),
      };
      return cadena;
    }),
    // The import reads one unit by code; the preview must not need it, but the
    // parity tests run the real import against the same fixture.
    findOne: jest.fn((filtro: Filtro) => {
      const { $regex, $options } = filtro.codigo as {
        $regex: string;
        $options?: string;
      };
      const patron = new RegExp($regex, $options);
      const u = unidades.find((x) => patron.test(x.codigo));
      const cadena = {
        select: () => cadena,
        lean: () => cadena,
        exec: () =>
          Promise.resolve(
            u ? { _id: u.id, titularId: u.titularId ?? null } : null,
          ),
      };
      return cadena;
    }),
    exists: jest.fn((filtro: Filtro) => {
      filtrosExists.push(filtro);
      return {
        exec: () =>
          Promise.resolve(
            titularesCompartidos.includes(filtro.titularId as string)
              ? { _id: 'otra' }
              : null,
          ),
      };
    }),
    create: jest.fn((doc: Filtro) => {
      void doc;
      return Promise.resolve({ _id: 'inm-nuevo' });
    }),
    insertMany: escritura(),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
    updateMany: escritura(),
    findOneAndUpdate: escritura(),
    replaceOne: escritura(),
    deleteOne: escritura(),
    deleteMany: escritura(),
    findOneAndDelete: escritura(),
  };
};

interface TerceroGuardado {
  nombre?: string | null;
  primerNombre?: string | null;
  primerApellido?: string | null;
  numeroIdentificacion?: string | null;
}

const tercerosModeloCon = (
  porIdentificacion: Record<string, string> = {},
  porId: Record<string, TerceroGuardado> = {},
) => {
  const filtrosFindOne: Filtro[] = [];
  const escritura = () => jest.fn();
  return {
    filtrosFindOne,
    findOne: jest.fn((filtro: Filtro) => {
      filtrosFindOne.push(filtro);
      const idPorIdentificacion =
        filtro.numeroIdentificacion !== undefined
          ? porIdentificacion[filtro.numeroIdentificacion as string]
          : undefined;
      const idBuscado = filtro._id as string | undefined;
      const resultado = idPorIdentificacion
        ? { _id: idPorIdentificacion, ...(porId[idPorIdentificacion] ?? {}) }
        : idBuscado && porId[idBuscado]
          ? { _id: idBuscado, ...porId[idBuscado] }
          : null;
      const cadena = {
        select: () => cadena,
        lean: () => cadena,
        exec: () => Promise.resolve(resultado),
      };
      return cadena;
    }),
    create: jest.fn((doc: Filtro) => {
      void doc;
      return Promise.resolve({ _id: 'ter-nuevo' });
    }),
    insertMany: escritura(),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
    updateMany: escritura(),
    findOneAndUpdate: escritura(),
    replaceOne: escritura(),
    deleteOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
    deleteMany: escritura(),
    findOneAndDelete: escritura(),
  };
};

const copropiedadModeloCon = (codigo = CODIGO_COPROPIEDAD) => ({
  findById: jest.fn(() => ({ exec: () => Promise.resolve({ codigo }) })),
});

const progresoModeloCon = () => ({
  intervalo: jest.fn(() => 1),
  iniciar: jest.fn().mockResolvedValue(undefined),
  actualizar: jest.fn().mockResolvedValue(undefined),
  finalizar: jest.fn().mockResolvedValue(undefined),
});

const tenant = {
  resolveCoPropertyId: () => COP,
} as unknown as TenantContextService;

const catalogos = {
  listarTiposIdentificacion: jest.fn(() => [
    { codigo: '13', nombre: 'Cedula de Ciudadania' },
    { codigo: '31', nombre: 'Nit' },
  ]),
  listarCiudades: jest.fn(() => [
    { codigo: '05001', nombre: 'Medellin', departamentoCodigo: '05' },
  ]),
};

const montar = (
  unidades: Unidad[] = [],
  opciones: {
    compartidos?: string[];
    porIdentificacion?: Record<string, string>;
    terceros?: Record<string, TerceroGuardado>;
    codigoCopropiedad?: string;
  } = {},
) => {
  const inmuebles = inmueblesModeloCon(unidades, opciones.compartidos);
  const terceros = tercerosModeloCon(
    opciones.porIdentificacion,
    opciones.terceros,
  );
  const progreso = progresoModeloCon();
  const service = new InmueblesService(
    inmuebles as never,
    copropiedadModeloCon(opciones.codigoCopropiedad) as never,
    terceros as never,
    tenant,
    catalogos as never,
    progreso as never,
  );
  return { service, inmuebles, terceros, progreso };
};

describe('InmueblesService.previsualizarImportacion — clasificación', () => {
  it('cuenta lo que se crearía y lo que se actualizaría, con los códigos nuevos', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: '301' }]);

    const vista = await service.previsualizarImportacion({
      filas: [
        fila({ codigo: '301' }),
        fila({ codigo: '302' }),
        fila({ codigo: ' 303 ' }),
      ],
    });

    expect(vista).toMatchObject({
      total: 3,
      aCrear: 2,
      aActualizar: 1,
      repetidasEnArchivo: 0,
      titularesNuevos: 0,
      errores: [],
      codigosACrear: ['302', '303'],
      codigosACrearTruncado: false,
      advertencias: [],
      abortaImport: false,
    });
  });

  it('el código se compara sin importar mayúsculas ni espacios, igual que el import', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: 'Torre A-301' }]);

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: ' torre a-301 ' })],
    });

    expect(vista.aActualizar).toBe(1);
    expect(vista.aCrear).toBe(0);
  });

  it('cuenta como titular nuevo solo las filas cuyo plan de titular es crear', async () => {
    const { service } = montar(
      [{ id: 'inm-1', codigo: '301', titularId: 'ter-1' }],
      {
        porIdentificacion: { '123': 'ter-1' },
        terceros: { 'ter-1': { nombre: 'Ana Pérez' } },
      },
    );

    const vista = await service.previsualizarImportacion({
      filas: [
        // identificación que existe: se refresca, no es nuevo
        fila({
          codigo: '301',
          nombreTitular: 'Ana Pérez',
          numeroIdentificacionTitular: '123',
        }),
        // inmueble nuevo con nombre: crea un tercero
        fila({ codigo: '302', nombreTitular: 'Luis Gómez' }),
        // inmueble nuevo sin titular: ninguno
        fila({ codigo: '303' }),
      ],
    });

    expect(vista.titularesNuevos).toBe(1);
    expect(vista.aCrear).toBe(2);
    expect(vista.aActualizar).toBe(1);
  });

  it('un código repetido en el archivo cuenta una vez; las demás van a repetidasEnArchivo con advertencia', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: '301' }]);

    const vista = await service.previsualizarImportacion({
      filas: [
        fila({ codigo: '301' }),
        fila({ codigo: '302' }),
        fila({ codigo: ' 301 ' }),
        fila({ codigo: '302' }),
      ],
    });

    expect(vista.aActualizar).toBe(1);
    expect(vista.aCrear).toBe(1);
    expect(vista.repetidasEnArchivo).toBe(2);
    expect(vista.advertencias).toEqual([
      { tipo: 'codigo-repetido-en-archivo', fila: 3, codigo: '301' },
      { tipo: 'codigo-repetido-en-archivo', fila: 4, codigo: '302' },
    ]);
  });

  it('si la primera aparición falla, la siguiente válida cuenta normalmente (como haría el import)', async () => {
    const { service } = montar();

    const vista = await service.previsualizarImportacion({
      filas: [
        fila({ codigo: '301', ciudadTitular: '99999' }),
        fila({ codigo: '301' }),
      ],
    });

    expect(vista.errores).toHaveLength(1);
    expect(vista.aCrear).toBe(1);
    expect(vista.repetidasEnArchivo).toBe(0);
  });
});

describe('InmueblesService.previsualizarImportacion — errores iguales a los del import', () => {
  const filasMalas = [
    fila({ codigo: '401', tipoIdentificacionTitular: 'CC' }),
    fila({ codigo: '402', ciudadTitular: '99999' }),
    fila({ codigo: '403', nombreTitular: 'Ana', emailTitular: 'no-es-correo' }),
    fila({ codigo: '404', numeroIdentificacionTitular: '999' }),
    fila({ codigo: '405' }),
  ];

  it('las mismas filas inválidas producen los mismos mensajes que importar', async () => {
    const vista = await montar([]).service.previsualizarImportacion({
      filas: filasMalas,
    });
    const real = await montar([]).service.importar({ filas: filasMalas });

    expect(vista.errores.length).toBe(4);
    expect(vista.errores).toEqual(real.errores);
    expect(vista.aCrear).toBe(real.creados);
  });

  it('también en inmuebles existentes', async () => {
    const unidades = filasMalas.map((f, i) => ({
      id: `inm-${i}`,
      codigo: f.codigo,
    }));

    const vista = await montar(unidades).service.previsualizarImportacion({
      filas: filasMalas,
    });
    const real = await montar(unidades).service.importar({ filas: filasMalas });

    expect(vista.errores).toEqual(real.errores);
    expect(vista.aActualizar).toBe(real.actualizados);
  });
});

describe('InmueblesService.previsualizarImportacion — no escribe nada', () => {
  it('ningún método de escritura de ningún modelo ni el progreso se tocan, en un archivo con altas, cambios y titulares', async () => {
    const { service, inmuebles, terceros, progreso } = montar(
      [
        { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
        { id: 'inm-2', codigo: '302', titularId: 'ter-2' },
      ],
      {
        porIdentificacion: { '123': 'ter-1' },
        terceros: {
          'ter-1': { nombre: 'Ana Pérez' },
          'ter-2': { nombre: 'Juan López', numeroIdentificacion: '777' },
        },
      },
    );

    await service.previsualizarImportacion({
      filas: [
        // refresca un tercero
        fila({
          codigo: '301',
          zona: 'Norte',
          nombreTitular: 'Ana Pérez',
          numeroIdentificacionTitular: '123',
        }),
        // venta sin identificación: crearía un tercero nuevo
        fila({ codigo: '302', nombreTitular: 'Pedro Gómez' }),
        // alta con titular nuevo
        fila({ codigo: '303', nombreTitular: 'Luis Gómez' }),
        // fila con error
        fila({ codigo: '304', ciudadTitular: '99999' }),
      ],
    });

    for (const modelo of [inmuebles, terceros]) {
      for (const metodo of METODOS_DE_ESCRITURA) {
        expect(modelo[metodo]).not.toHaveBeenCalled();
      }
    }
    expect(progreso.iniciar).not.toHaveBeenCalled();
    expect(progreso.actualizar).not.toHaveBeenCalled();
    expect(progreso.finalizar).not.toHaveBeenCalled();
  });

  it('tampoco escribe cuando el archivo se abortaría por otra copropiedad', async () => {
    const { service, inmuebles, terceros, progreso } = montar([], {
      codigoCopropiedad: '0001',
    });

    await service.previsualizarImportacion({
      filas: [fila({ codigoCopropiedad: 'OTRA' })],
    });

    for (const modelo of [inmuebles, terceros]) {
      for (const metodo of METODOS_DE_ESCRITURA) {
        expect(modelo[metodo]).not.toHaveBeenCalled();
      }
    }
    expect(progreso.iniciar).not.toHaveBeenCalled();
  });
});

describe('InmueblesService.previsualizarImportacion — códigos parecidos', () => {
  it('avisa cuando un código del archivo se parece a uno existente, sin cambiar los conteos', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: '0301' }]);

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '301' })],
    });

    expect(vista.advertencias).toEqual([
      {
        tipo: 'codigo-parecido',
        fila: 1,
        codigo: '301',
        parecidoA: '0301',
        origen: 'existente',
      },
    ]);
    // 0301 y 301 siguen siendo códigos distintos a propósito.
    expect(vista.aCrear).toBe(1);
    expect(vista.aActualizar).toBe(0);
  });

  it('avisa entre filas del archivo ("A-01" y "a1") y apunta a la primera', async () => {
    const { service } = montar();

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: 'A-01' }), fila({ codigo: 'a1' })],
    });

    expect(vista.advertencias).toEqual([
      {
        tipo: 'codigo-parecido',
        fila: 2,
        codigo: 'a1',
        parecidoA: 'A-01',
        origen: 'archivo',
      },
    ]);
    expect(vista.aCrear).toBe(2);
  });

  it('"301" y "3010" no se parecen, y el mismo código que ya existe no es una advertencia', async () => {
    const { service } = montar([
      { id: 'inm-1', codigo: '3010' },
      { id: 'inm-2', codigo: '302' },
    ]);

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '301' }), fila({ codigo: ' 302 ' })],
    });

    expect(vista.advertencias).toEqual([]);
  });

  it('un código repetido idéntico no genera además una advertencia de parecido', async () => {
    const { service } = montar();

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '301' }), fila({ codigo: '301' })],
    });

    expect(vista.advertencias.map((a) => a.tipo)).toEqual([
      'codigo-repetido-en-archivo',
    ]);
  });
});

describe('InmueblesService.previsualizarImportacion — ausentes', () => {
  it('solo cuenta los activos que el archivo no trae, sin importar mayúsculas ni espacios', async () => {
    const { service } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: 'Torre-1' },
      { id: 'inm-3', codigo: '303', estado: 'inactive' },
      { id: 'inm-4', codigo: '304' },
    ]);

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: ' 301 ' }), fila({ codigo: 'torre-1' })],
    });

    // 303 está inactivo: no se ofrece darlo de baja otra vez.
    expect(vista.ausentes).toEqual({
      total: 1,
      codigos: ['304'],
      truncado: false,
    });
  });

  it('una fila con error cuenta como presente: no se marca ausente por una fila mal escrita', async () => {
    const { service } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
    ]);

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '301', ciudadTitular: '99999' })],
    });

    expect(vista.errores).toHaveLength(1);
    expect(vista.ausentes.codigos).toEqual(['302']);
  });

  it('quedan vacíos cuando el archivo se abortaría', async () => {
    const { service, inmuebles } = montar([{ id: 'inm-1', codigo: '301' }], {
      codigoCopropiedad: '0001',
    });

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '999', codigoCopropiedad: 'OTRA' })],
    });

    expect(vista.ausentes).toEqual({ total: 0, codigos: [], truncado: false });
    expect(inmuebles.find).not.toHaveBeenCalled();
  });
});

describe('InmueblesService.previsualizarImportacion — copropiedad equivocada', () => {
  it('aborta TODO: abortaImport, solo las filas ajenas como errores y todo en cero', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: '301' }], {
      codigoCopropiedad: '0001',
    });

    const vista = await service.previsualizarImportacion({
      filas: [
        fila({ codigo: '301', codigoCopropiedad: '0001' }),
        fila({ codigo: '302', codigoCopropiedad: 'OTRA' }),
      ],
    });

    expect(vista).toEqual({
      total: 2,
      aCrear: 0,
      aActualizar: 0,
      repetidasEnArchivo: 0,
      titularesNuevos: 0,
      errores: [
        {
          fila: 2,
          codigo: '302',
          mensaje:
            'El código de copropiedad "OTRA" no coincide con el de la copropiedad activa (0001)',
        },
      ],
      codigosACrear: [],
      codigosACrearTruncado: false,
      advertencias: [],
      advertenciasTotal: 0,
      advertenciasTruncado: false,
      ausentes: { total: 0, codigos: [], truncado: false },
      abortaImport: true,
    });
  });

  it('usa el mismo mensaje que importar para la misma fila', async () => {
    const filas = [fila({ codigo: '302', codigoCopropiedad: 'OTRA' })];

    const vista = await montar().service.previsualizarImportacion({ filas });
    const real = await montar().service.importar({ filas });

    expect(vista.errores).toEqual(real.errores);
  });
});

describe('InmueblesService.previsualizarImportacion — tenencia y rendimiento', () => {
  it('todas las consultas llevan la copropiedad activa y las unidades se leen una sola vez', async () => {
    const { service, inmuebles, terceros } = montar(
      [{ id: 'inm-1', codigo: '301', titularId: 'ter-1' }],
      {
        porIdentificacion: { '123': 'ter-2' },
        terceros: { 'ter-1': { nombre: 'Ana Pérez' }, 'ter-2': {} },
      },
    );

    await service.previsualizarImportacion({
      filas: [
        fila({ codigo: '301', nombreTitular: 'Luis Gómez' }),
        fila({ codigo: '302', numeroIdentificacionTitular: '123' }),
        fila({ codigo: '303' }),
        fila({ codigo: '304' }),
      ],
    });

    expect(inmuebles.find).toHaveBeenCalledTimes(1);
    expect(inmuebles.findOne).not.toHaveBeenCalled();
    for (const filtro of [
      ...inmuebles.filtrosFind,
      ...inmuebles.filtrosExists,
      ...terceros.filtrosFindOne,
    ]) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    expect(terceros.filtrosFindOne.length).toBeGreaterThan(0);
  });

  it('los listados se recortan (200 códigos a crear, 500 ausentes) pero los conteos no', async () => {
    const existentes = Array.from({ length: 600 }, (_, i) => ({
      id: `inm-${i}`,
      codigo: `E${i}`,
    }));
    const { service } = montar(existentes);

    const vista = await service.previsualizarImportacion({
      filas: Array.from({ length: 250 }, (_, i) => fila({ codigo: `N${i}` })),
    });

    expect(vista.aCrear).toBe(250);
    expect(vista.codigosACrear).toHaveLength(200);
    expect(vista.codigosACrearTruncado).toBe(true);
    expect(vista.ausentes.total).toBe(600);
    expect(vista.ausentes.codigos).toHaveLength(500);
    expect(vista.ausentes.truncado).toBe(true);
  });

  it('justo en el tope no marca truncado', async () => {
    const existentes = Array.from({ length: 500 }, (_, i) => ({
      id: `inm-${i}`,
      codigo: `E${i}`,
    }));
    const { service } = montar(existentes);

    const vista = await service.previsualizarImportacion({
      filas: Array.from({ length: 200 }, (_, i) => fila({ codigo: `N${i}` })),
    });

    expect(vista.codigosACrearTruncado).toBe(false);
    expect(vista.ausentes.truncado).toBe(false);
  });
});

describe('InmueblesService.previsualizarImportacion — titulares nuevos sin sobrecontar', () => {
  it('un dueño con tres inmuebles nuevos y la misma identificación nueva cuenta UN titular nuevo', async () => {
    const { service } = montar();

    const vista = await service.previsualizarImportacion({
      filas: ['401', '402', '403'].map((codigo) =>
        fila({
          codigo,
          nombreTitular: 'Pedro Gómez',
          numeroIdentificacionTitular: '222',
        }),
      ),
    });

    expect(vista.aCrear).toBe(3);
    expect(vista.titularesNuevos).toBe(1);
  });

  it('identificaciones nuevas distintas cuentan cada una, y los titulares solo por nombre no se deduplican', async () => {
    const { service } = montar();

    const vista = await service.previsualizarImportacion({
      filas: [
        fila({
          codigo: '401',
          nombreTitular: 'A',
          numeroIdentificacionTitular: '1',
        }),
        fila({
          codigo: '402',
          nombreTitular: 'B',
          numeroIdentificacionTitular: '2',
        }),
        fila({ codigo: '403', nombreTitular: 'Luis Gómez' }),
        fila({ codigo: '404', nombreTitular: 'Luis Gómez' }),
      ],
    });

    // 2 identificaciones nuevas + 2 filas solo con nombre (no simuladas).
    expect(vista.titularesNuevos).toBe(4);
  });
});

describe('InmueblesService.previsualizarImportacion — código en blanco', () => {
  it('un código de solo espacios es un error de fila, no un alta, y es el mismo mensaje que da importar', async () => {
    const filas = [fila({ codigo: '   ' }), fila({ codigo: '302' })];

    const vista = await montar().service.previsualizarImportacion({ filas });
    const real = await montar().service.importar({ filas });

    expect(vista.errores).toEqual([
      { fila: 1, codigo: '   ', mensaje: 'El código no puede estar vacío' },
    ]);
    expect(vista.aCrear).toBe(1);
    expect(real.errores).toEqual(vista.errores);
    expect(real.creados).toBe(1);
  });
});

describe('InmueblesService.previsualizarImportacion — advertencias', () => {
  it('se recortan a 500 con el total y la marca de truncado; los conteos no se recortan', async () => {
    const { service } = montar();

    // 600 repeticiones del código "301": 599 advertencias de repetido.
    const vista = await service.previsualizarImportacion({
      filas: Array.from({ length: 600 }, () => fila({ codigo: '301' })),
    });

    expect(vista.repetidasEnArchivo).toBe(599);
    expect(vista.advertencias).toHaveLength(500);
    expect(vista.advertenciasTotal).toBe(599);
    expect(vista.advertenciasTruncado).toBe(true);
  });

  it('sin pasarse del tope informa el total y no marca truncado', async () => {
    const { service } = montar();

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '301' }), fila({ codigo: '301' })],
    });

    expect(vista.advertenciasTotal).toBe(1);
    expect(vista.advertenciasTruncado).toBe(false);
  });

  it('"1-23" y "12-3" ya no se avisan como parecidos', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: '12-3' }]);

    const vista = await service.previsualizarImportacion({
      filas: [fila({ codigo: '1-23' })],
    });

    expect(vista.advertencias).toEqual([]);
  });
});
