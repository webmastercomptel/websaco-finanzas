import { Types } from 'mongoose';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  InmueblesService,
  MAX_INMUEBLES_EXPORTACION,
} from './inmuebles.service';

const COP = new Types.ObjectId();
const TER_1 = new Types.ObjectId();
const TER_2 = new Types.ObjectId();

const tenant = { resolveCoPropertyId: () => COP } as never;

type Filtro = Record<string, unknown>;

/** Lean-chainable fake: records the filter, the `select`, the `sort` and the
 *  `limit` the service asked for, and answers with `filas`. */
const modeloCon = (filas: Record<string, unknown>[]) => {
  const llamadas: {
    filtro: Filtro;
    select?: string;
    sort?: Record<string, number>;
    limit?: number;
  }[] = [];
  return {
    llamadas,
    find: jest.fn((filtro: Filtro) => {
      const llamada: (typeof llamadas)[number] = { filtro };
      llamadas.push(llamada);
      const cadena = {
        select: (s: string) => {
          llamada.select = s;
          return cadena;
        },
        sort: (s: Record<string, number>) => {
          llamada.sort = s;
          return cadena;
        },
        limit: (n: number) => {
          llamada.limit = n;
          return cadena;
        },
        lean: () => cadena,
        exec: () => Promise.resolve(filas),
      };
      return cadena;
    }),
  };
};

const copropiedadModeloCon = (codigo = '0001') => ({
  findById: jest.fn(() => {
    const cadena = {
      select: () => cadena,
      lean: () => cadena,
      exec: () => Promise.resolve({ codigo }),
    };
    return cadena;
  }),
});

const servicio = (
  inmuebles: ReturnType<typeof modeloCon>,
  terceros: ReturnType<typeof modeloCon>,
  copropiedades = copropiedadModeloCon(),
) =>
  new InmueblesService(
    inmuebles as never,
    copropiedades as never,
    terceros as never,
    tenant,
    {} as never,
    {} as never,
  );

const unidad = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  codigo: '301',
  area: 50,
  resideEnElInmueble: false,
  titularId: null,
  ...over,
});

describe('InmueblesService.exportarImportacion', () => {
  it('consulta unidades y titulares con la copropiedad activa, sin paginar y ordenado por código', async () => {
    const inmuebles = modeloCon([unidad({ titularId: TER_1 })]);
    const terceros = modeloCon([{ _id: TER_1, primerNombre: 'Ana' }]);

    await servicio(inmuebles, terceros).exportarImportacion();

    expect(inmuebles.llamadas[0].filtro).toEqual({ copropiedadId: COP });
    expect(inmuebles.llamadas[0].sort).toEqual({ codigo: 1 });
    expect(inmuebles.llamadas[0].select).toContain('codigo');
    // Tenencia: el tercero se busca con copropiedadId Y con los ids que las
    // unidades referencian, nunca solo por _id.
    expect(terceros.llamadas[0].filtro).toEqual({
      copropiedadId: COP,
      _id: { $in: [TER_1] },
    });
  });

  it('incluye todas las unidades de la copropiedad, activas e inactivas: no filtra por estado', async () => {
    const inmuebles = modeloCon([unidad(), unidad({ codigo: '302' })]);

    const respuesta = await servicio(
      inmuebles,
      modeloCon([]),
    ).exportarImportacion();

    expect(inmuebles.llamadas[0].filtro).not.toHaveProperty('estado');
    expect(respuesta.filas.map((f) => f.codigo)).toEqual(['301', '302']);
  });

  it('devuelve el código de la copropiedad y lo repite en cada fila', async () => {
    const respuesta = await servicio(
      modeloCon([unidad(), unidad({ codigo: '302' })]),
      modeloCon([]),
      copropiedadModeloCon('0042'),
    ).exportarImportacion();

    expect(respuesta.copropiedadCodigo).toBe('0042');
    expect(respuesta.filas.map((f) => f.codigoCopropiedad)).toEqual([
      '0042',
      '0042',
    ]);
  });

  it('une cada unidad con su titular y deja vacías las columnas de la que no tiene', async () => {
    const respuesta = await servicio(
      modeloCon([
        unidad({ codigo: '301', titularId: TER_1 }),
        unidad({ codigo: '302', titularId: null }),
        unidad({ codigo: '303', titularId: TER_1 }),
      ]),
      modeloCon([
        {
          _id: TER_1,
          primerNombre: 'Ana',
          primerApellido: 'Pérez',
          numeroIdentificacion: '123',
          emails: ['a@x.co', 'b@x.co'],
          ciudadCodigo: '05001',
        },
      ]),
    ).exportarImportacion();

    expect(respuesta.filas[0]).toMatchObject({
      nom1Titular: 'Ana',
      numeroIdentificacionTitular: '123',
      emailTitular: 'a@x.co, b@x.co',
      ciudadTitular: '05001',
    });
    expect(respuesta.filas[1].numeroIdentificacionTitular).toBe('');
    expect(respuesta.filas[1].nom1Titular).toBe('');
    // Un titular compartido se consulta una sola vez y sirve a ambas unidades.
    expect(respuesta.filas[2].nom1Titular).toBe('Ana');
  });

  it('un titular que no es de esta copropiedad (el tercero no vuelve del filtro con tenencia) deja las columnas vacías', async () => {
    const respuesta = await servicio(
      modeloCon([unidad({ titularId: TER_2 })]),
      modeloCon([]),
    ).exportarImportacion();

    expect(respuesta.filas[0].nom1Titular).toBe('');
    expect(respuesta.filas[0].numeroIdentificacionTitular).toBe('');
  });

  it('no consulta terceros cuando ninguna unidad tiene titular', async () => {
    const terceros = modeloCon([]);

    await servicio(modeloCon([unidad()]), terceros).exportarImportacion();

    expect(terceros.find).not.toHaveBeenCalled();
  });

  it('falla con un mensaje claro si la copropiedad supera el tope defensivo', async () => {
    const inmuebles = modeloCon(
      Array.from({ length: MAX_INMUEBLES_EXPORTACION + 1 }, (_, i) =>
        unidad({ codigo: String(i) }),
      ),
    );

    await expect(
      servicio(inmuebles, modeloCon([])).exportarImportacion(),
    ).rejects.toThrow(UnprocessableEntityException);
    // Pide una fila de más: alcanza para saber que se pasó, sin cargar todo.
    expect(inmuebles.llamadas[0].limit).toBe(MAX_INMUEBLES_EXPORTACION + 1);
  });

  it('con exactamente el tope no falla', async () => {
    const inmuebles = modeloCon(
      Array.from({ length: MAX_INMUEBLES_EXPORTACION }, (_, i) =>
        unidad({ codigo: String(i) }),
      ),
    );

    const respuesta = await servicio(
      inmuebles,
      modeloCon([]),
    ).exportarImportacion();

    expect(respuesta.filas).toHaveLength(MAX_INMUEBLES_EXPORTACION);
  });
});
