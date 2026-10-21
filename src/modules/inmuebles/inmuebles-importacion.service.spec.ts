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

/** `copropiedades.findById(copropiedadId).exec()` — the whole-file
 *  `codigoCopropiedad` check reads `.codigo` from this before anything is
 *  written. Defaults to matching every `fila()` above so existing tests are
 *  unaffected; only the mismatch test overrides it. */
const copropiedadModeloCon = (codigo: string = CODIGO_COPROPIEDAD) => ({
  findById: jest.fn(() => ({ exec: () => Promise.resolve({ codigo }) })),
});

/** A unit already stored in the active coproperty. `tieneFacturas` is only
 *  documentation: the service has no Factura dependency at all, which is the
 *  point — an invoiced unit is patched like any other. */
interface InmuebleExistente {
  id: string;
  codigo: string;
  titularId?: string | null;
  tieneFacturas?: boolean;
}

/** Records every filter used and every unit written. `existentes` are the
 *  units already stored; `titularesCompartidos` are the titular ids that some
 *  OTHER unit also points at (what the shared-party check asks about).
 *  The delete spies exist only so a test can prove they are never touched. */
const inmueblesModeloCon = (
  existentes: InmuebleExistente[] = [],
  titularesCompartidos: string[] = [],
) => {
  const escrituras: Record<string, unknown>[] = [];
  const actualizaciones: {
    filtro: Filtro;
    cambios: Record<string, unknown>;
  }[] = [];
  const filtrosFindOne: Filtro[] = [];
  const filtrosExists: Filtro[] = [];
  return {
    escrituras,
    actualizaciones,
    filtrosFindOne,
    filtrosExists,
    findOne: jest.fn((filtro: Filtro) => {
      filtrosFindOne.push(filtro);
      // The service matches case/whitespace-insensitively — see
      // `InmueblesService.filtroCodigoDuplicado` — so this fake model matches
      // Mongo's own regex semantics instead of a plain string.
      const { $regex, $options } = filtro.codigo as {
        $regex: string;
        $options?: string;
      };
      const patron = new RegExp($regex, $options);
      const encontrado = existentes.find((e) => patron.test(e.codigo));
      const cadena = {
        select: () => cadena,
        lean: () => cadena,
        exec: () =>
          Promise.resolve(
            encontrado
              ? { _id: encontrado.id, titularId: encontrado.titularId ?? null }
              : null,
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
              ? { _id: 'otra-unidad' }
              : null,
          ),
      };
    }),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve({ _id: { toString: () => 'inm-nuevo' } });
    }),
    updateOne: jest.fn(
      (filtro: Filtro, { $set }: { $set: Record<string, unknown> }) => {
        actualizaciones.push({ filtro, cambios: $set });
        return { exec: () => Promise.resolve({ modifiedCount: 1 }) };
      },
    ),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    findOneAndDelete: jest.fn(),
  };
};

/** A working no-op progreso tracker — `importar()` calls it unconditionally,
 *  so every test here needs a real (if inert) implementation rather than
 *  `{} as never`. */
const progresoModeloCon = () => ({
  intervalo: jest.fn(() => 1),
  iniciar: jest.fn().mockResolvedValue(undefined),
  actualizar: jest.fn().mockResolvedValue(undefined),
  finalizar: jest.fn().mockResolvedValue(undefined),
});

/** A stored party, as far as the service reads it back. */
interface TerceroGuardado {
  primerNombre?: string | null;
  segundoNombre?: string | null;
  primerApellido?: string | null;
  segundoApellido?: string | null;
}

/** `porIdentificacion` maps an existing party's identification to its id;
 *  `porId` holds parties the service may read back by `_id` (a unit's own
 *  titular). Both lookups record the filter they were given. */
const tercerosModeloCon = (
  porIdentificacion: Record<string, string> = {},
  porId: Record<string, TerceroGuardado> = {},
) => {
  const creados: Record<string, unknown>[] = [];
  const actualizaciones: {
    id: string;
    filtro: Filtro;
    cambios: Record<string, unknown>;
  }[] = [];
  const filtrosFindOne: Filtro[] = [];
  return {
    creados,
    actualizaciones,
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
    create: jest.fn((doc: Record<string, unknown>) => {
      creados.push(doc);
      return Promise.resolve({ _id: 'ter-nuevo' });
    }),
    updateOne: jest.fn(
      (filtro: Filtro, { $set }: { $set: Record<string, unknown> }) => {
        actualizaciones.push({
          id: filtro._id as string,
          filtro,
          cambios: $set,
        });
        return { exec: () => Promise.resolve({ modifiedCount: 1 }) };
      },
    ),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    findOneAndDelete: jest.fn(),
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

const nuevoServicio = (
  inmuebles: ReturnType<typeof inmueblesModeloCon>,
  terceros: ReturnType<typeof tercerosModeloCon>,
  copropiedades: ReturnType<
    typeof copropiedadModeloCon
  > = copropiedadModeloCon(),
) =>
  new InmueblesService(
    inmuebles as never,
    copropiedades as never,
    terceros as never,
    tenant,
    catalogos as never,
    progresoModeloCon() as never,
  );

describe('InmueblesService.importar — alta de filas nuevas', () => {
  it('crea cada fila de un código nuevo como un inmueble, contando el total', async () => {
    const inmuebles = inmueblesModeloCon();
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [fila({ codigo: '301' }), fila({ codigo: '302' })],
    });

    expect(resultado).toEqual({
      total: 2,
      creados: 2,
      actualizados: 0,
      errores: [],
      eliminadosAntes: 0,
      bloqueadosPorFactura: [],
    });
    expect(inmuebles.escrituras).toHaveLength(2);
    expect(inmuebles.actualizaciones).toHaveLength(0);
  });

  it('un inmueble nuevo nace con los valores por defecto: propietario, no reside, vigente', async () => {
    const inmuebles = inmueblesModeloCon();
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(inmuebles.escrituras[0]).toMatchObject({
      tipoTitular: 'propietario',
      resideEnElInmueble: false,
      estadoCartera: 'vigente',
    });
  });

  it('una celda en blanco en un inmueble nuevo se trata como no enviada', async () => {
    const inmuebles = inmueblesModeloCon();
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    await service.importar({
      filas: [fila({ codigo: '301', referencia: '', bloque: '   ' })],
    });

    expect(inmuebles.escrituras[0].referencia).toBeUndefined();
    expect(inmuebles.escrituras[0].bloque).toBeUndefined();
  });

  it('escribe siempre la copropiedad activa, nunca una de la fila', async () => {
    const inmuebles = inmueblesModeloCon();
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(inmuebles.escrituras[0]).toMatchObject({ copropiedadId: COP });
  });
});

describe('InmueblesService.importar — actualización de inmuebles existentes', () => {
  it('un código que ya existe se actualiza (no se crea ni falla) y cuenta en actualizados', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [fila({ codigo: '301', zona: 'Norte', area: 55.5 })],
    });

    expect(resultado).toEqual({
      total: 1,
      creados: 0,
      actualizados: 1,
      errores: [],
      eliminadosAntes: 0,
      bloqueadosPorFactura: [],
    });
    expect(inmuebles.create).not.toHaveBeenCalled();
    expect(inmuebles.actualizaciones).toEqual([
      {
        filtro: { _id: 'inm-1', copropiedadId: COP },
        cambios: { zona: 'Norte', area: 55.5 },
      },
    ]);
  });

  it('un archivo mixto crea los códigos nuevos y actualiza los existentes, y cuenta cada grupo', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [
        fila({ codigo: '301', zona: 'Norte' }),
        fila({ codigo: '302' }),
        fila({ codigo: '303' }),
      ],
    });

    expect(resultado.creados).toBe(2);
    expect(resultado.actualizados).toBe(1);
    expect(resultado.errores).toEqual([]);
  });

  it('actualiza igual un inmueble que ya tiene facturas: no hay guarda de factura porque nada se borra', async () => {
    // El servicio ni siquiera depende del modelo Factura. La guarda de factura
    // existía solo para proteger el borrado masivo previo, que ya no existe.
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', tieneFacturas: true },
    ]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [fila({ codigo: '301', uso: 'Vivienda' })],
    });

    expect(resultado.actualizados).toBe(1);
    expect(resultado.errores).toEqual([]);
    expect(inmuebles.actualizaciones[0].cambios).toEqual({ uso: 'Vivienda' });
  });

  it('encuentra el inmueble con otra capitalización o espacios y no crea un duplicado', async () => {
    // Mismo criterio que el alta manual — ver `filtroCodigoDuplicado`.
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: 'Torre A-301' },
    ]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [fila({ codigo: ' torre a-301 ', zona: 'Norte' })],
    });

    expect(resultado.creados).toBe(0);
    expect(resultado.actualizados).toBe(1);
    expect(inmuebles.actualizaciones[0].filtro).toEqual({
      _id: 'inm-1',
      copropiedadId: COP,
    });
  });

  it('nunca escribe el código del inmueble al actualizar, ni siquiera con otra capitalización', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: 'Torre A-301' },
    ]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    await service.importar({
      filas: [fila({ codigo: ' TORRE a-301 ', zona: 'Norte' })],
    });

    expect(inmuebles.actualizaciones[0].cambios).not.toHaveProperty('codigo');
  });

  it('nunca toca el estado del inmueble: uno inactivo sigue inactivo tras reimportar', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    await service.importar({
      filas: [
        fila({ codigo: '301', zona: 'Norte', estadoCartera: 'juridico' }),
      ],
    });

    expect(inmuebles.actualizaciones[0].cambios).not.toHaveProperty('estado');
  });

  it('las celdas en blanco o solo con espacios conservan el valor guardado', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          referencia: '',
          bloque: '   ',
          zona: 'Norte',
          contacto: '',
          observaciones: ' \t ',
        }),
      ],
    });

    expect(inmuebles.actualizaciones[0].cambios).toEqual({ zona: 'Norte' });
  });

  it('una fila que solo trae el código cuenta como actualizada pero no escribe nada', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [fila({ codigo: '301', zona: '' })],
    });

    expect(resultado.actualizados).toBe(1);
    expect(inmuebles.updateOne).not.toHaveBeenCalled();
  });

  it('una fila con un código de tipo de identificación inexistente en un inmueble existente falla sola, sin escribir nada de esa fila', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
    ]);
    const terceros = tercerosModeloCon({ '123': 'ter-1' });
    const service = nuevoServicio(inmuebles, terceros);

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          zona: 'Norte',
          numeroIdentificacionTitular: '123',
          tipoIdentificacionTitular: 'CC',
        }),
        fila({ codigo: '302', zona: 'Sur' }),
      ],
    });

    expect(resultado.actualizados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]).toMatchObject({ fila: 1, codigo: '301' });
    expect(resultado.errores[0].mensaje).toContain('CC');
    expect(terceros.updateOne).not.toHaveBeenCalled();
    expect(inmuebles.actualizaciones).toHaveLength(1);
    expect(inmuebles.actualizaciones[0].filtro).toEqual({
      _id: 'inm-2',
      copropiedadId: COP,
    });
  });

  it('una fila con un código de ciudad inexistente en un inmueble existente falla sola, sin escribir nada de esa fila', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          zona: 'Norte',
          razonSocialTitular: 'Ferretería SAS',
          ciudadTitular: '99999',
        }),
      ],
    });

    expect(resultado.actualizados).toBe(0);
    expect(resultado.errores[0].mensaje).toContain('99999');
    expect(inmuebles.updateOne).not.toHaveBeenCalled();
    expect(terceros.create).not.toHaveBeenCalled();
  });

  it('una fila con un email inválido falla sola y no escribe el inmueble', async () => {
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const service = nuevoServicio(inmuebles, tercerosModeloCon());

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          zona: 'Norte',
          nombreTitular: 'Ana Pérez',
          emailTitular: 'no-es-un-correo',
        }),
      ],
    });

    expect(resultado.actualizados).toBe(0);
    expect(resultado.errores[0].mensaje).toContain('no-es-un-correo');
    expect(inmuebles.updateOne).not.toHaveBeenCalled();
  });
});

describe('InmueblesService.importar — titular de un inmueble existente', () => {
  it('con la misma identificación refresca el titular con los datos de la fila', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const service = nuevoServicio(inmuebles, terceros);

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
      filtro: { _id: 'ter-1', copropiedadId: COP },
      cambios: {
        tipoPersona: 'natural',
        nombre: 'Ana Pérez',
        tipoIdentificacion: '13',
        direccion: 'Calle 10 # 20-30',
        ciudad: 'Medellin',
        ciudadCodigo: '05001',
        ciudadDepartamentoCodigo: '05',
      },
    });
  });

  it('sin nombre en la fila no borra el nombre ya guardado del titular', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const service = nuevoServicio(inmuebles, terceros);

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
      telefono: '3000000000',
    });
  });

  it('las celdas del titular en blanco conservan lo guardado: solo se escribe lo que la fila trae', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          numeroIdentificacionTitular: '123456',
          nom1Titular: '',
          ape1Titular: '  ',
          emailTitular: '',
          telefonoTitular: '3000000000',
          direccionTitular: ' ',
          ciudadTitular: '',
        }),
      ],
    });

    expect(terceros.actualizaciones[0].cambios).toEqual({
      telefono: '3000000000',
    });
  });

  it('reasigna el inmueble cuando la identificación apunta a otro tercero', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-viejo' },
    ]);
    const terceros = tercerosModeloCon({ '999': 'ter-nuevo-dueno' });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nombreTitular: 'Nuevo Dueño',
          numeroIdentificacionTitular: '999',
        }),
      ],
    });

    expect(inmuebles.actualizaciones[0].cambios).toEqual({
      titularId: 'ter-nuevo-dueno',
    });
    // El titular anterior no se toca: puede seguir siendo dueño de otras unidades.
    expect(terceros.actualizaciones.map((a) => a.id)).toEqual([
      'ter-nuevo-dueno',
    ]);
  });

  it('sin identificación pero con nombre refresca el titular propio del inmueble cuando no es compartido', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({}, { 'ter-1': {} });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nom1Titular: 'Ana',
          ape1Titular: 'Pérez',
          telefonoTitular: '3111111111',
        }),
      ],
    });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(terceros.actualizaciones).toHaveLength(1);
    expect(terceros.actualizaciones[0]).toMatchObject({
      id: 'ter-1',
      filtro: { _id: 'ter-1', copropiedadId: COP },
      cambios: {
        nombre: 'Ana Pérez',
        primerNombre: 'Ana',
        primerApellido: 'Pérez',
        telefono: '3111111111',
      },
    });
    expect(inmuebles.actualizaciones[0].cambios).toEqual({
      titularId: 'ter-1',
    });
    // La pregunta "¿lo comparte otra unidad?" se hace con la copropiedad y
    // excluyendo la unidad que se está importando.
    expect(inmuebles.filtrosExists).toEqual([
      { copropiedadId: COP, titularId: 'ter-1', _id: { $ne: 'inm-1' } },
    ]);
  });

  it('sin identificación y con el titular compartido por otra unidad crea un tercero NUEVO y deja intacto al compartido', async () => {
    // Pisar el nombre de un dueño compartido porque una de sus unidades se
    // vendió corrompería sus otras unidades.
    const inmuebles = inmueblesModeloCon(
      [{ id: 'inm-1', codigo: '301', titularId: 'ter-1' }],
      ['ter-1'],
    );
    const terceros = tercerosModeloCon({}, { 'ter-1': {} });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({ codigo: '301', nom1Titular: 'Luis', ape1Titular: 'Gómez' }),
      ],
    });

    expect(terceros.actualizaciones).toHaveLength(0);
    expect(terceros.creados).toHaveLength(1);
    expect(terceros.creados[0]).toMatchObject({
      copropiedadId: COP,
      nombre: 'Luis Gómez',
    });
    expect(inmuebles.actualizaciones[0].cambios).toEqual({
      titularId: 'ter-nuevo',
    });
  });

  it('sin identificación y con el inmueble sin titular crea un tercero nuevo y se lo asigna', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: null },
    ]);
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [fila({ codigo: '301', nombreTitular: 'Ana Pérez' })],
    });

    expect(terceros.creados).toHaveLength(1);
    expect(inmuebles.actualizaciones[0].cambios).toEqual({
      titularId: 'ter-nuevo',
    });
  });

  it('sin datos de titular en la fila deja el titular del inmueble como está', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({}, { 'ter-1': {} });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [fila({ codigo: '301', zona: 'Norte' })],
    });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(terceros.updateOne).not.toHaveBeenCalled();
    expect(inmuebles.actualizaciones[0].cambios).toEqual({ zona: 'Norte' });
  });

  it('una fila con solo un apellido no identifica a nadie: no toca al titular guardado', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({}, { 'ter-1': {} });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [fila({ codigo: '301', ape2Titular: 'Gómez-Ruiz' })],
    });

    expect(terceros.updateOne).not.toHaveBeenCalled();
    expect(terceros.create).not.toHaveBeenCalled();
  });

  it('si la fila trae solo algunas partes del nombre, el resto sale del titular guardado para no truncar el nombre', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon(
      {},
      {
        'ter-1': {
          primerNombre: 'Juan',
          segundoNombre: 'Carlos',
          primerApellido: 'Pérez',
          segundoApellido: 'Gómez',
        },
      },
    );
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nom1Titular: 'Juan',
          ape1Titular: 'Pérez',
          ape2Titular: 'Gómez-Ruiz',
        }),
      ],
    });

    expect(terceros.actualizaciones[0].cambios).toMatchObject({
      nombre: 'Juan Carlos Pérez Gómez-Ruiz',
      segundoApellido: 'Gómez-Ruiz',
    });
  });
});

describe('InmueblesService.importar — titulares de filas nuevas', () => {
  it('reutiliza un tercero existente por identificación, sin duplicarlo', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const service = nuevoServicio(inmuebles, terceros);

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
    expect(inmuebles.escrituras[0]).toMatchObject({ titularId: 'ter-1' });
  });

  it('crea un tercero nuevo cuando la identificación no coincide con ninguno', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [fila({ codigo: '301', nombreTitular: 'Ana Pérez' })],
    });

    expect(terceros.creados[0]).toMatchObject({
      copropiedadId: COP,
      nombre: 'Ana Pérez',
    });
    expect(inmuebles.escrituras[0]).toMatchObject({ titularId: 'ter-nuevo' });
  });

  it('parte emailTitular en varias direcciones, separadas por coma o punto y coma', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nombreTitular: 'Ana Pérez',
          emailTitular:
            ' ana@ejemplo.com , gestor@ejemplo.com;otro@ejemplo.com ',
        }),
      ],
    });

    expect(terceros.creados[0]).toMatchObject({
      emails: ['ana@ejemplo.com', 'gestor@ejemplo.com', 'otro@ejemplo.com'],
    });
  });

  it('un email inválido en emailTitular falla solo esa fila', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          nombreTitular: 'Ana Pérez',
          emailTitular: 'no-es-un-correo',
        }),
      ],
    });

    expect(resultado.creados).toBe(0);
    expect(resultado.errores[0].mensaje).toContain('no-es-un-correo');
    expect(terceros.create).not.toHaveBeenCalled();
  });

  it('concatena nom1Titular/ape1Titular en name para un titular persona natural', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

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
      tipoPersona: 'natural',
      nombre: 'Ana María Pérez Gómez',
      primerNombre: 'Ana',
      segundoNombre: 'María',
      primerApellido: 'Pérez',
      segundoApellido: 'Gómez',
    });
  });

  it('usa razonSocialTitular para un titular persona jurídica', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [fila({ codigo: '301', razonSocialTitular: 'Ferretería SAS' })],
    });

    expect(terceros.creados[0]).toMatchObject({
      tipoPersona: 'juridica',
      nombre: 'Ferretería SAS',
      razonSocial: 'Ferretería SAS',
    });
  });

  it('deja el inmueble sin titular cuando la fila no trae ninguno: se carga antes que sus papeles', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0].titularId).toBeUndefined();
  });

  it('guarda la dirección del titular tal cual viene en la fila', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

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
      direccion: 'Calle 10 # 20-30',
    });
  });

  it('resuelve el código de ciudad a su nombre y el código de su departamento', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

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
      ciudad: 'Medellin',
      ciudadCodigo: '05001',
      ciudadDepartamentoCodigo: '05',
    });
  });

  it('una fila con un código de ciudad inexistente falla sola, sin abortar el resto', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

    const resultado = await service.importar({
      filas: [
        fila({
          codigo: '301',
          razonSocialTitular: 'Ferretería SAS',
          ciudadTitular: '99999',
        }),
        fila({ codigo: '302' }),
      ],
    });

    expect(resultado.creados).toBe(1);
    expect(resultado.errores[0].mensaje).toContain('99999');
    expect(terceros.create).not.toHaveBeenCalled();
  });

  it('una fila con un código de tipo de identificación inexistente falla sola', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(inmuebles, terceros);

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
});

describe('InmueblesService.importar — garantías', () => {
  it('un código de copropiedad que no coincide aborta TODO el archivo, sin escribir ni consultar nada', async () => {
    // A diferencia de un código de inmueble con error (falla solo esa fila),
    // un archivo de otra copropiedad no puede tener la oportunidad de
    // modificar el listado de esta — por eso es el único chequeo que aborta el
    // archivo completo en lugar de fallar fila por fila.
    const inmuebles = inmueblesModeloCon([{ id: 'inm-1', codigo: '301' }]);
    const terceros = tercerosModeloCon();
    const service = nuevoServicio(
      inmuebles,
      terceros,
      copropiedadModeloCon('0001'),
    );

    const resultado = await service.importar({
      filas: [
        fila({ codigo: '301', codigoCopropiedad: '0001', zona: 'Norte' }),
        fila({ codigo: '302', codigoCopropiedad: 'OTRA' }),
      ],
    });

    expect(resultado).toEqual({
      total: 2,
      creados: 0,
      actualizados: 0,
      errores: [
        {
          fila: 2,
          codigo: '302',
          mensaje:
            'El código de copropiedad "OTRA" no coincide con el de la copropiedad activa (0001)',
        },
      ],
      eliminadosAntes: 0,
      bloqueadosPorFactura: [],
    });
    expect(inmuebles.findOne).not.toHaveBeenCalled();
    expect(inmuebles.create).not.toHaveBeenCalled();
    expect(inmuebles.updateOne).not.toHaveBeenCalled();
    expect(terceros.create).not.toHaveBeenCalled();
    expect(terceros.updateOne).not.toHaveBeenCalled();
  });

  it('todas las consultas y escrituras llevan la copropiedad activa (ley de tenencia)', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
    ]);
    const terceros = tercerosModeloCon({ '123': 'ter-2' }, { 'ter-1': {} });
    const service = nuevoServicio(inmuebles, terceros);

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          zona: 'Norte',
          numeroIdentificacionTitular: '123',
        }),
        fila({ codigo: '302', nom1Titular: 'Ana', ape1Titular: 'Pérez' }),
        fila({ codigo: '303', zona: 'Sur' }),
      ],
    });

    expect(inmuebles.filtrosFindOne.length).toBeGreaterThan(0);
    for (const filtro of inmuebles.filtrosFindOne) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    expect(terceros.filtrosFindOne.length).toBeGreaterThan(0);
    for (const filtro of terceros.filtrosFindOne) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    for (const { filtro } of inmuebles.actualizaciones) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    for (const { filtro } of terceros.actualizaciones) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    expect(terceros.creados.every((t) => t.copropiedadId === COP)).toBe(true);
    expect(inmuebles.escrituras.every((u) => u.copropiedadId === COP)).toBe(
      true,
    );
  });

  it('nunca borra nada: un inmueble ausente del archivo sigue ahí y ningún modelo recibe un borrado', async () => {
    const inmuebles = inmueblesModeloCon([
      { id: 'inm-1', codigo: '301', titularId: 'ter-1' },
      { id: 'inm-9', codigo: '999' },
    ]);
    const terceros = tercerosModeloCon({}, { 'ter-1': {} });
    const service = nuevoServicio(inmuebles, terceros);

    // El inmueble 999 está en la copropiedad pero ausente del archivo.
    const resultado = await service.importar({
      filas: [
        fila({ codigo: '301', nom1Titular: 'Ana', ape1Titular: 'Pérez' }),
        fila({ codigo: '302' }),
      ],
    });

    expect(resultado.eliminadosAntes).toBe(0);
    expect(resultado.bloqueadosPorFactura).toEqual([]);
    for (const modelo of [inmuebles, terceros]) {
      expect(modelo.deleteOne).not.toHaveBeenCalled();
      expect(modelo.deleteMany).not.toHaveBeenCalled();
      expect(modelo.findOneAndDelete).not.toHaveBeenCalled();
    }
  });
});
