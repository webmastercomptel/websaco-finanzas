import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ETIQUETA_UNIDAD } from './detector-unidades';
import type { GrupoDePaginas } from './lector-pdf-bloque';
import {
  claveLockIngesta,
  FacturacionBloqueIngestaService,
  TAMANO_MAXIMO_BLOQUE_BYTES,
  VIGENCIA_PROCESAMIENTO_MS,
} from './facturacion-bloque-ingesta.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  lean: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.lean = jest.fn().mockReturnValue(q);
  return q;
};

const llamada = (mock: jest.Mock, n = 0): unknown[] =>
  (mock.mock.calls as unknown[][])[n];

const COPROPIEDAD = new Types.ObjectId();
const BLOQUE = new Types.ObjectId();
const RUTA_ORIGINAL = `facturacion-bloque/${COPROPIEDAD.toString()}/${BLOQUE.toString()}/original.pdf`;

const bloqueDoc = (extra: Record<string, unknown> = {}) => ({
  _id: BLOQUE,
  copropiedadId: COPROPIEDAD,
  tipo: 'factura',
  periodo: '2026-07',
  nombre: 'bloque.pdf',
  rutaOriginal: RUTA_ORIGINAL,
  estado: 'procesando',
  ...extra,
});

/** Page text with the unit label the detector looks for. */
const pagina = (codigo: string | null) =>
  codigo === null
    ? 'Portada sin identificador'
    : `${ETIQUETA_UNIDAD}: ${codigo} Total $100`;

interface Unidad {
  id: Types.ObjectId;
  codigo: string;
}

function montar(
  opciones: {
    textos?: string[];
    unidades?: Unidad[];
    tamano?: number;
    bloqueReclamado?: ReturnType<typeof bloqueDoc> | null;
    lockLibre?: boolean;
  } = {},
) {
  const unidades = opciones.unidades ?? [
    { id: new Types.ObjectId(), codigo: '301' },
    { id: new Types.ObjectId(), codigo: '302' },
  ];
  const textos = opciones.textos ?? [pagina('301'), pagina('302')];

  const bloques = {
    findOneAndUpdate: jest
      .fn()
      .mockReturnValue(
        consulta(
          opciones.bloqueReclamado === undefined
            ? bloqueDoc()
            : opciones.bloqueReclamado,
        ),
      ),
    findOne: jest.fn().mockReturnValue(consulta(null)),
    updateOne: jest.fn().mockReturnValue(consulta({ matchedCount: 1 })),
    deleteOne: jest.fn().mockReturnValue(consulta({ deletedCount: 1 })),
  };
  const documentos = {
    create: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockReturnValue(consulta({ deletedCount: 0 })),
  };
  const inmuebles = {
    find: jest
      .fn()
      .mockReturnValue(
        consulta(unidades.map((u) => ({ _id: u.id, codigo: u.codigo }))),
      ),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const orden: string[] = [];
  const almacen = {
    tamanoReal: jest.fn().mockResolvedValue(opciones.tamano ?? 5_000_000),
    descargar: jest.fn().mockImplementation(() => {
      orden.push('descargar');
      return Promise.resolve(Buffer.from('%PDF-falso'));
    }),
    subir: jest.fn().mockResolvedValue(undefined),
    eliminar: jest.fn().mockResolvedValue(true),
    eliminarPrefijo: jest
      .fn()
      .mockResolvedValue({ eliminados: 0, fallidos: 0 }),
  };
  const lector = {
    textoPorPagina: jest.fn().mockImplementation(() => {
      orden.push('texto');
      return Promise.resolve([...textos]);
    }),
    dividir: jest
      .fn()
      .mockImplementation(
        async (
          _origen: Uint8Array,
          grupos: GrupoDePaginas[],
          alProducir: (clave: string, pdf: Uint8Array) => Promise<void>,
        ) => {
          orden.push('dividir');
          for (const g of grupos) {
            await alProducir(g.clave, new Uint8Array([1, 2, 3]));
          }
        },
      ),
  };
  const lock = {
    runExclusive: jest
      .fn()
      .mockImplementation(
        async (_clave: string, _ttl: number, tarea: () => Promise<void>) => {
          if (opciones.lockLibre === false) return false;
          await tarea();
          return true;
        },
      ),
  };

  const servicio = new FacturacionBloqueIngestaService(
    bloques as never,
    documentos as never,
    inmuebles as never,
    tenant as never,
    almacen as never,
    lector,
    lock as never,
  );

  const updatesDeBloque = () =>
    bloques.updateOne.mock.calls.map(([filtro, cambio]) => ({
      filtro: filtro as Record<string, unknown>,
      set: (cambio as { $set: Record<string, unknown> }).$set,
    }));
  const estadoFinal = () =>
    updatesDeBloque()
      .filter((u) => 'estado' in u.set)
      .map((u) => u.set)
      .pop();

  return {
    servicio,
    bloques,
    documentos,
    inmuebles,
    almacen,
    lector,
    lock,
    unidades,
    orden,
    updatesDeBloque,
    estadoFinal,
  };
}

describe('FacturacionBloqueIngestaService — camino feliz', () => {
  it('detecta la unidad de cada página, guarda un PDF por unidad y deja el bloque generado SIN enviar nada', async () => {
    const { servicio, unidades, almacen, documentos, estadoFinal } = montar();

    const reporte = await servicio.procesar(BLOQUE.toString());

    expect(reporte).toEqual({
      id: BLOQUE.toString(),
      estado: 'generado',
      totalPaginas: 2,
      totalUnidades: 2,
      unidades: ['301', '302'],
      paginasSinMatch: [],
      unidadesNoRegistradas: [],
    });
    expect(almacen.subir).toHaveBeenCalledTimes(2);
    expect(documentos.create).toHaveBeenCalledTimes(2);
    expect(llamada(documentos.create)[0]).toMatchObject({
      copropiedadId: COPROPIEDAD,
      bloqueId: BLOQUE,
      inmuebleId: unidades[0].id,
      codigoInmueble: '301',
      tipo: 'factura',
      periodo: '2026-07',
      paginas: [1],
      tamanoBytes: 3,
    });
    expect(estadoFinal()).toMatchObject({
      estado: 'generado',
      totalPaginas: 2,
      totalUnidades: 2,
      tokenProcesamiento: null,
      procesamientoIniciadoEn: null,
    });
  });

  it('cada PDF de unidad va a una ruta determinista dentro del prefijo del bloque, nombrada por el id del inmueble', async () => {
    const { servicio, unidades, almacen } = montar();

    await servicio.procesar(BLOQUE.toString());

    const rutas = almacen.subir.mock.calls.map(([ruta]) => ruta as string);
    expect(rutas).toEqual(
      unidades.map(
        (u) =>
          `facturacion-bloque/${COPROPIEDAD.toString()}/${BLOQUE.toString()}/unidades/${u.id.toString()}.pdf`,
      ),
    );
  });

  it('el código guardado en el documento es el del Inmueble tal como está registrado, no el normalizado del PDF', async () => {
    const id = new Types.ObjectId();
    const { servicio, documentos } = montar({
      textos: [pagina('torre')],
      unidades: [{ id, codigo: 'Torre' }],
    });

    await servicio.procesar(BLOQUE.toString());

    expect(llamada(documentos.create)[0]).toMatchObject({
      codigoInmueble: 'Torre',
      inmuebleId: id,
    });
  });

  it('las páginas sin unidad se reportan y no se pierden en silencio', async () => {
    const { servicio, estadoFinal } = montar({
      textos: [pagina(null), pagina('301'), pagina('302'), pagina(null)],
    });

    const reporte = await servicio.procesar(BLOQUE.toString());

    expect(reporte.paginasSinMatch).toEqual([1, 4]);
    expect(reporte.totalPaginas).toBe(4);
    expect(estadoFinal()?.paginasSinMatch).toEqual([1, 4]);
  });

  it('una unidad repetida en páginas separadas se junta en UN solo documento con todas sus páginas', async () => {
    const { servicio, documentos, lector } = montar({
      textos: [pagina('301'), pagina('302'), pagina('301'), pagina('301')],
    });

    const reporte = await servicio.procesar(BLOQUE.toString());

    expect(reporte.totalUnidades).toBe(2);
    expect(documentos.create).toHaveBeenCalledTimes(2);
    const grupos = llamada(lector.dividir)[1] as GrupoDePaginas[];
    expect(grupos.find((g) => g.paginas.length === 3)?.paginas).toEqual([
      1, 3, 4,
    ]);
  });

  it('un código del PDF que no es un inmueble de la copropiedad se reporta y NO genera documento', async () => {
    const { servicio, documentos, lector, estadoFinal } = montar({
      textos: [pagina('301'), pagina('999'), pagina('302'), pagina('999')],
    });

    const reporte = await servicio.procesar(BLOQUE.toString());

    expect(reporte.unidadesNoRegistradas).toEqual([
      { codigo: '999', paginas: [2, 4] },
    ]);
    expect(reporte.unidades).toEqual(['301', '302']);
    expect(documentos.create).toHaveBeenCalledTimes(2);
    const grupos = llamada(lector.dividir)[1] as GrupoDePaginas[];
    expect(grupos.flatMap((g) => g.paginas)).not.toContain(2);
    expect(estadoFinal()?.unidadesNoRegistradas).toEqual([
      { codigo: '999', paginas: [2, 4] },
    ]);
  });

  it('solo cuenta los inmuebles ACTIVOS de la copropiedad al reconocer unidades', async () => {
    const { servicio, inmuebles } = montar();

    await servicio.procesar(BLOQUE.toString());

    expect(llamada(inmuebles.find)[0]).toEqual({
      copropiedadId: COPROPIEDAD,
      estado: 'active',
    });
  });

  it('dos inmuebles cuyo código coincide al normalizar (a-1 y A-1) se descartan: ninguna página se asigna a ciegas', async () => {
    const { servicio, documentos } = montar({
      textos: [pagina('A-1'), pagina('302')],
      unidades: [
        { id: new Types.ObjectId(), codigo: 'a-1' },
        { id: new Types.ObjectId(), codigo: 'A-1' },
        { id: new Types.ObjectId(), codigo: '302' },
      ],
    });

    const reporte = await servicio.procesar(BLOQUE.toString());

    expect(reporte.unidades).toEqual(['302']);
    expect(reporte.unidadesNoRegistradas).toEqual([
      { codigo: 'A-1', paginas: [1] },
    ]);
    expect(documentos.create).toHaveBeenCalledTimes(1);
  });

  it('borra la salida de una corrida anterior (filas y archivos) antes de generar la nueva', async () => {
    const { servicio, documentos, almacen, orden } = montar();

    await servicio.procesar(BLOQUE.toString());

    expect(llamada(documentos.deleteMany)[0]).toEqual({
      copropiedadId: COPROPIEDAD,
      bloqueId: BLOQUE,
    });
    expect(llamada(almacen.eliminarPrefijo)[0]).toBe(
      `facturacion-bloque/${COPROPIEDAD.toString()}/${BLOQUE.toString()}/unidades/`,
    );
    expect(orden.at(-1)).toBe('dividir');
  });

  it('la transición final exige el token del lease: un request que lo perdió no pisa al nuevo dueño', async () => {
    const { servicio, bloques } = montar();
    bloques.updateOne.mockReturnValue(consulta({ matchedCount: 0 }));

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('FacturacionBloqueIngestaService — límites de memoria', () => {
  it('lee el texto y recién después divide: dos descargas separadas, nunca las dos fases con el PDF a la vez', async () => {
    const { servicio, orden } = montar();

    await servicio.procesar(BLOQUE.toString());

    expect(orden).toEqual(['descargar', 'texto', 'descargar', 'dividir']);
  });

  it('el lector de texto recibe una vista sobre el MISMO buffer descargado (sin duplicar el PDF en memoria)', async () => {
    const { servicio, lector, almacen } = montar();
    const grande = Buffer.alloc(8192, 1);
    almacen.descargar.mockResolvedValue(grande);

    await servicio.procesar(BLOQUE.toString());

    const vista = llamada(lector.textoPorPagina)[0] as Uint8Array;
    expect(vista.buffer).toBe(grande.buffer);
    expect(vista.byteLength).toBe(grande.byteLength);
  });

  it('una unidad a la vez: cada PDF se sube apenas se corta, no se acumulan todos', async () => {
    const { servicio, almacen, lector } = montar();
    let subidosAlTerminarDividir = -1;
    lector.dividir.mockImplementation(
      async (
        _o: Uint8Array,
        grupos: GrupoDePaginas[],
        alProducir: (c: string, p: Uint8Array) => Promise<void>,
      ) => {
        for (const g of grupos) {
          await alProducir(g.clave, new Uint8Array(1));
          // Cada salida ya fue subida antes de pedir la siguiente.
          expect(almacen.subir.mock.calls.length).toBeGreaterThan(0);
        }
        subidosAlTerminarDividir = almacen.subir.mock.calls.length;
      },
    );

    await servicio.procesar(BLOQUE.toString());

    expect(subidosAlTerminarDividir).toBe(2);
  });

  it('tamaño máximo aceptado: 200 MB', () => {
    expect(TAMANO_MAXIMO_BLOQUE_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('FacturacionBloqueIngestaService — un solo procesamiento a la vez', () => {
  it('mientras uno corre, otro en el mismo proceso se rechaza con 429 SIN tocar la base ni el almacenamiento', async () => {
    const { servicio, almacen, bloques } = montar();
    let liberar!: () => void;
    const detenido = new Promise<void>((resolver) => {
      liberar = resolver;
    });
    almacen.tamanoReal.mockImplementation(async () => {
      await detenido;
      return 1000;
    });

    const primero = servicio.procesar(BLOQUE.toString());
    // Deja que el primero llegue a su primer await.
    await new Promise((r) => setImmediate(r));

    const segundo = servicio.procesar(new Types.ObjectId().toString());
    await expect(segundo).rejects.toBeInstanceOf(HttpException);
    await expect(segundo).rejects.toMatchObject({ status: 429 });
    expect(bloques.findOneAndUpdate).toHaveBeenCalledTimes(1);

    liberar();
    await expect(primero).resolves.toMatchObject({ estado: 'generado' });
  });

  it('al terminar el primero, el siguiente procesamiento sí corre', async () => {
    const { servicio } = montar();

    await servicio.procesar(BLOQUE.toString());

    await expect(servicio.procesar(BLOQUE.toString())).resolves.toBeDefined();
  });

  it('el semáforo se libera aunque el procesamiento falle', async () => {
    const { servicio, almacen } = montar();
    almacen.tamanoReal.mockRejectedValueOnce(new Error('no existe'));

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await expect(servicio.procesar(BLOQUE.toString())).resolves.toBeDefined();
  });

  it('toma un lock de Redis POR copropiedad, con TTL de la vigencia del lease', async () => {
    const { servicio, lock } = montar();

    await servicio.procesar(BLOQUE.toString());

    expect(llamada(lock.runExclusive).slice(0, 2)).toEqual([
      claveLockIngesta(COPROPIEDAD.toString()),
      VIGENCIA_PROCESAMIENTO_MS,
    ]);
    expect(claveLockIngesta(COPROPIEDAD.toString())).toBe(
      `facturacion-bloque:ingesta:${COPROPIEDAD.toString()}`,
    );
  });

  it('si otra instancia tiene el lock de la copropiedad (o Redis no responde) rechaza con 429 y no reclama el bloque', async () => {
    const { servicio, bloques } = montar({ lockLibre: false });

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toMatchObject({
      status: 429,
    });
    expect(bloques.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('FacturacionBloqueIngestaService — reclamar', () => {
  it('toma el bloque con UN update atómico por id Y copropiedad, solo desde pendiente, error o un procesando vencido', async () => {
    const { servicio, bloques } = montar();

    await servicio.procesar(BLOQUE.toString());

    const [filtro, cambio, opciones] = llamada(bloques.findOneAndUpdate) as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
      unknown,
    ];
    expect(filtro._id).toBe(BLOQUE.toString());
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    const alternativas = filtro.$or as Array<Record<string, unknown>>;
    expect(alternativas[0]).toEqual({
      estado: { $in: ['pendiente', 'error'] },
    });
    expect(alternativas[1]).toMatchObject({ estado: 'procesando' });
    expect(JSON.stringify(alternativas)).not.toMatch(
      /generado|enviado|pendiente_envio/,
    );
    expect(cambio.$set).toMatchObject({
      estado: 'procesando',
      motivoError: null,
    });
    expect(typeof cambio.$set.tokenProcesamiento).toBe('string');
    expect(opciones).toEqual({ new: true });
  });

  it('un id mal formado es 404 y no toca la base', async () => {
    const { servicio, bloques } = montar();

    await expect(servicio.procesar('xyz')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(bloques.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un bloque de otra copropiedad o inexistente es 404 (se busca por id Y copropiedad)', async () => {
    const { servicio, bloques } = montar({ bloqueReclamado: null });

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(llamada(bloques.findOne)[0]).toEqual({
      _id: BLOQUE.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it.each([
    ['procesando', 'se está procesando'],
    ['generado', 'ya fue procesado'],
    ['pendiente_envio', 'ya fue procesado'],
    ['enviado', 'ya fue procesado'],
  ])('si el bloque está %s responde 409', async (estado, fragmento) => {
    const { servicio, bloques } = montar({ bloqueReclamado: null });
    bloques.findOne.mockReturnValue(consulta({ estado }));

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(fragmento);
  });
});

describe('FacturacionBloqueIngestaService — fallas', () => {
  it('si todas las páginas quedan sin unidad marca error con el motivo y responde 400, sin generar nada', async () => {
    const { servicio, lector, estadoFinal } = montar({
      textos: [pagina(null), pagina(null)],
    });

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toBeInstanceOf(BadRequestException);
    await expect(intento).rejects.toThrow('no contiene identificadores');
    expect(estadoFinal()).toMatchObject({
      estado: 'error',
      motivoError: expect.stringContaining('identificadores') as string,
    });
    expect(lector.dividir).not.toHaveBeenCalled();
  });

  it('si hay códigos pero NINGUNO es un inmueble activo, marca error y no genera documentos', async () => {
    const { servicio, lector, documentos } = montar({
      textos: [pagina('888'), pagina('999')],
    });

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toThrow('ninguno corresponde a un inmueble');
    expect(lector.dividir).not.toHaveBeenCalled();
    expect(documentos.create).not.toHaveBeenCalled();
  });

  it('la guarda de privacidad: un código impreso que continúa tras una unidad registrada no se entrega a esa unidad', async () => {
    const { servicio, lector } = montar({
      textos: [`${ETIQUETA_UNIDAD}: 301 - 2024 Total`],
      unidades: [{ id: new Types.ObjectId(), codigo: '301' }],
    });

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toThrow('sin ambigüedad');
    expect(lector.dividir).not.toHaveBeenCalled();
  });

  it('un PDF ilegible marca error y responde 400', async () => {
    const { servicio, lector, estadoFinal } = montar();
    lector.textoPorPagina.mockRejectedValue(new Error('Invalid PDF'));

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toThrow('No se pudo leer el PDF');
    expect(estadoFinal()).toMatchObject({ estado: 'error' });
  });

  it('si el objeto no se subió devuelve el bloque a pendiente (para confirmar de nuevo) y responde 400', async () => {
    const { servicio, almacen, estadoFinal, lector } = montar();
    almacen.tamanoReal.mockRejectedValue(new Error('404'));

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toThrow('no se subió correctamente');
    expect(estadoFinal()).toMatchObject({ estado: 'pendiente' });
    expect(lector.textoPorPagina).not.toHaveBeenCalled();
  });

  it('un objeto por encima de 200 MB (aunque se declaró menos) se rechaza: se borra el registro y el objeto', async () => {
    const { servicio, almacen, bloques, lector } = montar({
      tamano: TAMANO_MAXIMO_BLOQUE_BYTES + 1,
    });

    const intento = servicio.procesar(BLOQUE.toString());

    await expect(intento).rejects.toThrow('límite de 200 MB');
    expect(llamada(bloques.deleteOne)[0]).toMatchObject({
      _id: BLOQUE,
      copropiedadId: COPROPIEDAD,
    });
    expect(almacen.eliminar).toHaveBeenCalledWith(RUTA_ORIGINAL);
    expect(almacen.descargar).not.toHaveBeenCalled();
    expect(lector.textoPorPagina).not.toHaveBeenCalled();
  });

  it('un objeto de exactamente 200 MB se acepta', async () => {
    const { servicio } = montar({ tamano: TAMANO_MAXIMO_BLOQUE_BYTES });

    await expect(servicio.procesar(BLOQUE.toString())).resolves.toBeDefined();
  });

  it('una falla de Storage al descargar NO acusa al archivo: vuelve a pendiente y propaga el error original', async () => {
    const { servicio, almacen, estadoFinal } = montar();
    almacen.descargar.mockRejectedValue(new Error('ECONNRESET'));

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toThrow(
      'ECONNRESET',
    );
    expect(estadoFinal()).toMatchObject({ estado: 'pendiente' });
  });

  it('una falla al cortar o subir deja el bloque en error reintentable y relanza', async () => {
    const { servicio, almacen, estadoFinal } = montar();
    almacen.subir.mockRejectedValue(new Error('storage caído'));

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toThrow(
      'storage caído',
    );
    expect(estadoFinal()).toMatchObject({
      estado: 'error',
      motivoError: expect.stringContaining('Reintentá') as string,
    });
  });

  it('renueva el lease durante un procesamiento largo y aborta si lo perdió', async () => {
    const muchas = Array.from({ length: 30 }, (_, i) => ({
      id: new Types.ObjectId(),
      codigo: `U${i}`,
    }));
    const { servicio, bloques } = montar({
      unidades: muchas,
      textos: muchas.map((u) => pagina(u.codigo)),
    });
    bloques.updateOne.mockReturnValue(consulta({ matchedCount: 0 }));

    await expect(servicio.procesar(BLOQUE.toString())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
