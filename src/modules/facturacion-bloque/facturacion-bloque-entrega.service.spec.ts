import { ConflictException, NotFoundException } from '@nestjs/common';
import { Mongoose, Types } from 'mongoose';
import type { ResidenteDeInmueble } from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { BloqueFacturacionSchema } from '../../database/schemas/administracion/bloque-facturacion.schema';
import {
  ENVIOS_SIMULTANEOS,
  FacturacionBloqueEntregaService,
  VIGENCIA_ENLACE_MS,
  VIGENCIA_ENVIO_MS,
} from './facturacion-bloque-entrega.service';

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
const ADMIN = new Types.ObjectId();
const user: IRequestUser = {
  uid: 'u',
  email: 'admin@b.co',
  accountId: ADMIN.toString(),
  nombre: 'Ana Administradora',
};

const bloqueDoc = (extra: Record<string, unknown> = {}) => ({
  _id: BLOQUE,
  copropiedadId: COPROPIEDAD,
  tipo: 'factura',
  periodo: '2026-07',
  nombre: 'bloque.pdf',
  estado: 'pendiente_envio',
  destinatariosTotal: 0,
  correoConfigurado: null,
  enviadoEn: new Date('2026-07-01T10:00:00.000Z'),
  enviadoPorNombre: 'Ana Administradora',
  createdAt: new Date('2026-07-01T09:00:00.000Z'),
  updatedAt: new Date('2026-07-01T09:00:00.000Z'),
  ...extra,
});

const documentoDoc = (
  codigo: string,
  extra: Record<string, unknown> = {},
  inmuebleId = new Types.ObjectId(),
) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  bloqueId: BLOQUE,
  inmuebleId,
  codigoInmueble: codigo,
  tipo: 'factura',
  periodo: '2026-07',
  paginas: [1],
  tamanoBytes: 100,
  notificadosIds: [] as Types.ObjectId[],
  correosEnviadosIds: [] as Types.ObjectId[],
  ...extra,
});

const persona = (
  n: number,
  rol: 'propietario' | 'arrendatario',
): ResidenteDeInmueble => ({
  accountId: new Types.ObjectId().toString(),
  email: `persona${n}@example.com`,
  nombre: `Persona ${n}`,
  perfil: 'residente',
  rol,
});

interface LlamadaUpdateOne {
  filtro: Record<string, unknown>;
  cambio: Record<string, Record<string, unknown>>;
}

function montar(
  opciones: {
    documentos?: ReturnType<typeof documentoDoc>[];
    residentes?: Map<string, ResidenteDeInmueble[]>;
    correoConfigurado?: boolean;
    tipo?: string;
  } = {},
) {
  const documentos = opciones.documentos ?? [];
  const bloques = {
    findOneAndUpdate: jest
      .fn()
      .mockReturnValue(
        consulta(bloqueDoc({ tipo: opciones.tipo ?? 'factura' })),
      ),
    findOne: jest.fn().mockReturnValue(consulta(bloqueDoc())),
    updateOne: jest.fn().mockReturnValue(consulta({ matchedCount: 1 })),
  };
  const docs = {
    find: jest.fn().mockReturnValue(consulta(documentos)),
    updateOne: jest.fn().mockReturnValue(consulta({ matchedCount: 1 })),
  };
  const copropiedades = {
    findById: jest
      .fn()
      .mockReturnValue(consulta({ nombre: 'Torres del Parque' })),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const directorio = {
    residentesDeInmuebles: jest
      .fn<
        Promise<Map<string, ResidenteDeInmueble[]>>,
        [Types.ObjectId, Types.ObjectId[]]
      >()
      .mockResolvedValue(opciones.residentes ?? new Map()),
  };
  const correo = {
    estaConfigurado: jest
      .fn<boolean, []>()
      .mockReturnValue(opciones.correoConfigurado ?? true),
    enviar: jest
      .fn<Promise<boolean>, [{ para: string; asunto: string; html: string }]>()
      .mockResolvedValue(true),
  };
  const enlaces = {
    construir: jest
      .fn<Promise<string | null>, [string, string, string, number?]>()
      .mockResolvedValue('https://app.test/auth/enlace?token=abc'),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };

  const servicio = new FacturacionBloqueEntregaService(
    bloques as never,
    docs as never,
    copropiedades as never,
    tenant as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );

  const updatesDeBloque = (): LlamadaUpdateOne[] =>
    bloques.updateOne.mock.calls.map(([filtro, cambio]) => ({
      filtro: filtro as Record<string, unknown>,
      cambio: cambio as Record<string, Record<string, unknown>>,
    }));
  const finalizacion = (): LlamadaUpdateOne | undefined =>
    updatesDeBloque().find((l) => l.cambio.$set && 'estado' in l.cambio.$set);
  /** (document id, account id) recorded as delivered into `campo`. */
  const registrados = (campo: string): Array<[string, string]> =>
    docs.updateOne.mock.calls
      .map(([filtro, cambio]) => ({
        filtro: filtro as { _id: Types.ObjectId },
        cambio: cambio as Record<string, Record<string, unknown>>,
      }))
      .filter((l) => l.cambio.$addToSet && campo in l.cambio.$addToSet)
      .map((l) => [l.filtro._id.toString(), String(l.cambio.$addToSet[campo])]);

  return {
    servicio,
    bloques,
    docs,
    tenant,
    directorio,
    correo,
    enlaces,
    notificaciones,
    finalizacion,
    registrados,
  };
}

/** One unit per entry, each with the given residents. */
function escenario(
  unidades: Array<{
    codigo: string;
    residentes: ResidenteDeInmueble[];
    documento?: Record<string, unknown>;
  }>,
) {
  const documentos = unidades.map((u) => documentoDoc(u.codigo, u.documento));
  const residentes = new Map(
    unidades.map((u, i) => [documentos[i].inmuebleId.toString(), u.residentes]),
  );
  return { documentos, residentes };
}

describe('FacturacionBloqueEntregaService — reclamar', () => {
  it('toma el envío con UN update atómico filtrado por id Y copropiedad, solo desde generado o pendiente_envio con lease vencido', async () => {
    const { servicio, bloques } = montar();

    await servicio.enviar(BLOQUE.toString(), user);

    const [filtro, pipeline, opciones] = bloques.findOneAndUpdate.mock
      .calls[0] as [Record<string, unknown>, unknown[], unknown];
    expect(filtro._id).toBe(BLOQUE.toString());
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    const alternativas = filtro.$or as Array<Record<string, unknown>>;
    expect(alternativas[0]).toEqual({ estado: 'generado' });
    expect(alternativas[1]).toMatchObject({ estado: 'pendiente_envio' });
    // enviado, pendiente, procesando y error no son reclamables.
    expect(JSON.stringify(alternativas)).not.toContain('"enviado"');
    expect(Array.isArray(pipeline)).toBe(true);
    expect(opciones).toEqual({ new: true, updatePipeline: true });
  });

  it('un bloque de recibos queda fuera del reclamo en el propio filtro', async () => {
    const { servicio, bloques } = montar();

    await servicio.enviar(BLOQUE.toString(), user);

    const filtro = llamada(bloques.findOneAndUpdate)[0] as {
      tipo: { $in: string[] };
    };
    expect(filtro.tipo.$in).toEqual(['factura', 'estado_cuenta']);
    expect(filtro.tipo.$in).not.toContain('recibo');
  });

  it('el lease vencido se mide contra VIGENCIA_ENVIO_MS', async () => {
    const { servicio, bloques } = montar();
    const antes = Date.now();

    await servicio.enviar(BLOQUE.toString(), user);

    const filtro = llamada(bloques.findOneAndUpdate)[0] as {
      $or: Array<{ $or?: Array<Record<string, unknown>> }>;
    };
    const interno = filtro.$or[1].$or ?? [];
    expect(interno[0]).toEqual({ envioIniciadoEn: null });
    const limite = (interno[1].envioIniciadoEn as { $lt: Date }).$lt;
    expect(antes - limite.getTime()).toBeGreaterThanOrEqual(
      VIGENCIA_ENVIO_MS - 50,
    );
    expect(antes - limite.getTime()).toBeLessThan(VIGENCIA_ENVIO_MS + 5000);
  });

  it('quién envía y cuándo salen de la cuenta de quien llama y se estampan solo la primera vez', async () => {
    const { servicio, bloques } = montar();

    await servicio.enviar(BLOQUE.toString(), user);

    const pipeline = llamada(bloques.findOneAndUpdate)[1] as Array<{
      $set: Record<string, unknown>;
    }>;
    const set = pipeline[0].$set;
    expect(set.estado).toBe('pendiente_envio');
    expect(typeof set.tokenEnvio).toBe('string');
    expect(set.enviadoEn).toEqual({
      $ifNull: ['$enviadoEn', expect.any(Date)],
    });
    expect(set.enviadoPorId).toEqual({
      $cond: [expect.anything(), { $literal: ADMIN }, '$enviadoPorId'],
    });
    // El nombre va como literal: uno que empiece con "$" es dato, no una ruta.
    expect(set.enviadoPorNombre).toEqual({
      $cond: [
        expect.anything(),
        { $literal: 'Ana Administradora' },
        '$enviadoPorNombre',
      ],
    });
  });

  it('acepta la forma real del update (Mongoose 9 valida opciones y pipeline al armar la consulta)', () => {
    const Bloque = new Mongoose().model('Bloque', BloqueFacturacionSchema);

    expect(() =>
      Bloque.findOneAndUpdate(
        { _id: BLOQUE, copropiedadId: COPROPIEDAD, estado: 'generado' },
        [
          {
            $set: {
              estado: 'pendiente_envio',
              enviadoEn: { $ifNull: ['$enviadoEn', new Date()] },
              enviadoPorNombre: { $cond: [true, { $literal: '$x' }, '$y'] },
            },
          },
        ],
        { new: true, updatePipeline: true },
      ),
    ).not.toThrow();
  });

  it('un id mal formado es 404 y no toca la base', async () => {
    const { servicio, bloques } = montar();

    await expect(servicio.enviar('no-es-un-id', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(bloques.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un bloque inexistente o de otra copropiedad es 404', async () => {
    const { servicio, bloques } = montar();
    bloques.findOneAndUpdate.mockReturnValue(consulta(null));
    bloques.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.enviar(BLOQUE.toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(llamada(bloques.findOne)[0]).toEqual({
      _id: BLOQUE.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it.each([
    ['enviado', 'ya fue enviado'],
    ['pendiente_envio', 'en proceso de envío'],
    ['generado', 'todavía no está procesado'],
    ['pendiente', 'todavía no está procesado'],
    ['procesando', 'todavía no está procesado'],
    ['error', 'todavía no está procesado'],
  ])(
    'si no se puede reclamar y el estado es %s responde 409 (%s)',
    async (estado, fragmento) => {
      const { servicio, bloques } = montar();
      bloques.findOneAndUpdate.mockReturnValue(consulta(null));
      bloques.findOne.mockReturnValue(
        consulta(bloqueDoc({ estado, tipo: 'factura' })),
      );

      const intento = servicio.enviar(BLOQUE.toString(), user);

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(fragmento);
    },
  );

  it('un bloque de recibos no se envía nunca: 409 con su propio mensaje y nadie recibe nada', async () => {
    const { servicio, bloques, correo, notificaciones } = montar();
    bloques.findOneAndUpdate.mockReturnValue(consulta(null));
    bloques.findOne.mockReturnValue(
      consulta(bloqueDoc({ estado: 'generado', tipo: 'recibo' })),
    );

    const intento = servicio.enviar(BLOQUE.toString(), user);

    await expect(intento).rejects.toThrow('recibos');
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });
});

describe('FacturacionBloqueEntregaService — a quién le llega qué', () => {
  it('el propietario Y el arrendatario de una unidad reciben cada uno su aviso y su correo', async () => {
    const dueno = persona(1, 'propietario');
    const inquilino = persona(2, 'arrendatario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno, inquilino] },
    ]);
    const { servicio, correo, notificaciones, registrados } = montar({
      documentos,
      residentes,
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar.mock.calls.map(([m]) => m.para).sort()).toEqual([
      'persona1@example.com',
      'persona2@example.com',
    ]);
    expect(
      notificaciones.crear.mock.calls.map(
        ([n]) => (n as { accountId: string }).accountId,
      ),
    ).toEqual(expect.arrayContaining([dueno.accountId, inquilino.accountId]));
    expect(registrados('notificadosIds')).toHaveLength(2);
    expect(registrados('correosEnviadosIds')).toHaveLength(2);
  });

  it('la notificación es del tipo pago, de la copropiedad activa, con el asunto del correo', async () => {
    const dueno = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno] },
    ]);
    const { servicio, notificaciones } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(llamada(notificaciones.crear)[0]).toEqual({
      copropiedadId: COPROPIEDAD,
      accountId: dueno.accountId,
      tipo: 'pago',
      titulo: 'Tu factura de 2026-07 ya está disponible',
    });
  });

  it('el enlace del correo apunta a /portal/mis-documentos?abrir=<id del documento de esa unidad>', async () => {
    const dueno = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno] },
    ]);
    const { servicio, enlaces } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(enlaces.construir).toHaveBeenCalledWith(
      dueno.accountId,
      COPROPIEDAD.toString(),
      `/portal/mis-documentos?abrir=${documentos[0]._id.toString()}`,
      VIGENCIA_ENLACE_MS,
    );
  });

  it('una unidad sin arrendatario envía solo al propietario y no falla', async () => {
    const dueno = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno] },
    ]);
    const { servicio, correo, finalizacion } = montar({
      documentos,
      residentes,
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(finalizacion()?.cambio.$set.estado).toBe('enviado');
  });

  it('una unidad sin ninguna cuenta alcanzable se reporta en unidadesSinDestinatario y no impide cerrar el envío', async () => {
    const dueno = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno] },
      { codigo: '302', residentes: [] },
      { codigo: '202', residentes: [] },
    ]);
    const { servicio, finalizacion } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(finalizacion()?.cambio.$set).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 1,
      unidadesSinDestinatario: ['202', '302'],
    });
  });

  it('el arrendatario NO recibe un estado de cuenta; el propietario sí', async () => {
    const dueno = persona(1, 'propietario');
    const inquilino = persona(2, 'arrendatario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno, inquilino] },
    ]);
    const documentosEstado = documentos.map((d) => ({
      ...d,
      tipo: 'estado_cuenta',
    }));
    const { servicio, correo, notificaciones } = montar({
      documentos: documentosEstado,
      residentes,
      tipo: 'estado_cuenta',
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar.mock.calls.map(([m]) => m.para)).toEqual([
      'persona1@example.com',
    ]);
    expect(
      notificaciones.crear.mock.calls.map(
        ([n]) => (n as { accountId: string }).accountId,
      ),
    ).toEqual([dueno.accountId]);
  });

  it('si la unidad solo tiene arrendatario con cuenta y el bloque es de estados de cuenta, la unidad queda sin destinatario', async () => {
    const inquilino = persona(2, 'arrendatario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [inquilino] },
    ]);
    const { servicio, correo, finalizacion } = montar({
      documentos: documentos.map((d) => ({ ...d, tipo: 'estado_cuenta' })),
      residentes,
      tipo: 'estado_cuenta',
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(finalizacion()?.cambio.$set.unidadesSinDestinatario).toEqual([
      '301',
    ]);
  });

  it('pide los residentes por id de unidad, en una sola consulta para todas las unidades', async () => {
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [persona(1, 'propietario')] },
      { codigo: '302', residentes: [persona(2, 'propietario')] },
    ]);
    const { servicio, directorio } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(directorio.residentesDeInmuebles).toHaveBeenCalledTimes(1);
    expect(directorio.residentesDeInmuebles).toHaveBeenCalledWith(
      COPROPIEDAD,
      documentos.map((d) => d.inmuebleId),
    );
  });

  it('el mismo propietario de dos unidades recibe un aviso por unidad (la entrega es por documento y destinatario)', async () => {
    const dueno = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [dueno] },
      { codigo: '302', residentes: [dueno] },
    ]);
    const { servicio, correo, enlaces } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar).toHaveBeenCalledTimes(2);
    expect(
      enlaces.construir.mock.calls.map(([, , destino]) => destino).sort(),
    ).toEqual(
      documentos
        .map((d) => `/portal/mis-documentos?abrir=${d._id.toString()}`)
        .sort(),
    );
  });
});

describe('FacturacionBloqueEntregaService — reintento y progreso', () => {
  it('reenviar tras una falla parcial solo alcanza a quien faltaba: no duplica a quien ya recibió', async () => {
    const ana = persona(1, 'propietario');
    const beto = persona(2, 'propietario');
    const { documentos, residentes } = escenario([
      {
        codigo: '301',
        residentes: [ana],
        documento: {
          notificadosIds: [new Types.ObjectId(ana.accountId)],
          correosEnviadosIds: [new Types.ObjectId(ana.accountId)],
        },
      },
      { codigo: '302', residentes: [beto] },
    ]);
    const { servicio, correo, notificaciones, enlaces } = montar({
      documentos,
      residentes,
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar.mock.calls.map(([m]) => m.para)).toEqual([
      'persona2@example.com',
    ]);
    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
    expect(enlaces.construir).toHaveBeenCalledTimes(1);
  });

  it('con el aviso ya creado pero sin correo, solo reintenta el correo (no repite la notificación)', async () => {
    const ana = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      {
        codigo: '301',
        residentes: [ana],
        documento: { notificadosIds: [new Types.ObjectId(ana.accountId)] },
      },
    ]);
    const { servicio, correo, notificaciones, registrados } = montar({
      documentos,
      residentes,
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(notificaciones.crear).not.toHaveBeenCalled();
    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(registrados('correosEnviadosIds')).toHaveLength(1);
  });

  it('un correo rechazado deja a esa persona pendiente, sigue con las demás y el bloque queda pendiente_envio', async () => {
    const ana = persona(1, 'propietario');
    const beto = persona(2, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [ana] },
      { codigo: '302', residentes: [beto] },
    ]);
    const { servicio, correo, registrados, finalizacion } = montar({
      documentos,
      residentes,
    });
    correo.enviar.mockImplementation(({ para }) =>
      Promise.resolve(para !== 'persona1@example.com'),
    );

    await servicio.enviar(BLOQUE.toString(), user);

    expect(registrados('correosEnviadosIds')).toEqual([
      [documentos[1]._id.toString(), beto.accountId],
    ]);
    expect(finalizacion()?.cambio.$set.estado).toBe('pendiente_envio');
  });

  it('una excepción en una entrega no detiene las otras ni sale de la solicitud', async () => {
    const ana = persona(1, 'propietario');
    const beto = persona(2, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [ana] },
      { codigo: '302', residentes: [beto] },
    ]);
    const { servicio, enlaces, correo } = montar({ documentos, residentes });
    enlaces.construir.mockRejectedValueOnce(new Error('boom'));

    await expect(
      servicio.enviar(BLOQUE.toString(), user),
    ).resolves.toBeDefined();

    expect(correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('sin correo configurado crea los avisos de la app pero NO declara el bloque enviado', async () => {
    const ana = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [ana] },
    ]);
    const { servicio, correo, notificaciones, finalizacion } = montar({
      documentos,
      residentes,
      correoConfigurado: false,
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(finalizacion()?.cambio.$set).toMatchObject({
      estado: 'pendiente_envio',
      correoConfigurado: false,
    });
  });

  it('cierra como enviado solo con todo entregado, y suelta el lease en la misma escritura', async () => {
    const ana = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [ana] },
    ]);
    const { servicio, finalizacion } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    const final = finalizacion();
    expect(final?.filtro).toMatchObject({
      _id: BLOQUE,
      copropiedadId: COPROPIEDAD,
      tokenEnvio: expect.any(String) as string,
    });
    expect(final?.cambio.$set).toMatchObject({
      estado: 'enviado',
      tokenEnvio: null,
      envioIniciadoEn: null,
      destinatariosTotal: 1,
    });
  });

  it('reparte las entregas en tandas de ENVIOS_SIMULTANEOS y renueva el lease tras cada una', async () => {
    const total = ENVIOS_SIMULTANEOS * 2 + 3;
    const unidades = Array.from({ length: total }, (_, i) => ({
      codigo: `U${i}`,
      residentes: [persona(i, 'propietario')],
    }));
    const { documentos, residentes } = escenario(unidades);
    const { servicio, correo, bloques } = montar({ documentos, residentes });

    let activos = 0;
    let maximo = 0;
    correo.enviar.mockImplementation(async () => {
      activos++;
      maximo = Math.max(maximo, activos);
      await new Promise((r) => setTimeout(r, 1));
      activos--;
      return true;
    });

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar).toHaveBeenCalledTimes(total);
    expect(maximo).toBe(ENVIOS_SIMULTANEOS);
    const latidos = bloques.updateOne.mock.calls.filter(
      ([, cambio]) =>
        'envioIniciadoEn' in
          ((cambio as { $set: Record<string, unknown> }).$set ?? {}) &&
        !('estado' in (cambio as { $set: Record<string, unknown> }).$set),
    );
    expect(latidos).toHaveLength(3);
  });

  it('si pierde el lease en un latido deja de entregar y no escribe el estado final', async () => {
    const unidades = Array.from({ length: ENVIOS_SIMULTANEOS + 2 }, (_, i) => ({
      codigo: `U${i}`,
      residentes: [persona(i, 'propietario')],
    }));
    const { documentos, residentes } = escenario(unidades);
    const { servicio, correo, bloques, finalizacion } = montar({
      documentos,
      residentes,
    });
    bloques.updateOne.mockReturnValue(consulta({ matchedCount: 0 }));

    await servicio.enviar(BLOQUE.toString(), user);

    expect(correo.enviar).toHaveBeenCalledTimes(ENVIOS_SIMULTANEOS);
    expect(finalizacion()).toBeUndefined();
  });

  it('ante un error inesperado suelta el lease (para reanudar al instante) y relanza', async () => {
    const { servicio, directorio, bloques } = montar({
      documentos: [documentoDoc('301')],
    });
    directorio.residentesDeInmuebles.mockRejectedValue(
      new Error('mongo caído'),
    );

    await expect(servicio.enviar(BLOQUE.toString(), user)).rejects.toThrow(
      'mongo caído',
    );

    const liberacion = (bloques.updateOne.mock.calls as unknown[][]).find(
      ([, cambio]) =>
        (cambio as { $set?: Record<string, unknown> }).$set?.tokenEnvio ===
        null,
    );
    expect(liberacion).toBeDefined();
    expect((liberacion?.[1] as { $set: Record<string, unknown> }).$set).toEqual(
      {
        tokenEnvio: null,
        envioIniciadoEn: null,
      },
    );
  });

  it('el registro de progreso filtra por documento Y copropiedad y usa $addToSet', async () => {
    const ana = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      { codigo: '301', residentes: [ana] },
    ]);
    const { servicio, docs } = montar({ documentos, residentes });

    await servicio.enviar(BLOQUE.toString(), user);

    const [filtro, cambio] = docs.updateOne.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filtro).toEqual({
      _id: documentos[0]._id,
      copropiedadId: COPROPIEDAD,
    });
    expect(Object.keys(cambio)).toEqual(['$addToSet']);
  });

  it('responde con el conteo de la entrega salido de los ids registrados', async () => {
    const ana = persona(1, 'propietario');
    const { documentos, residentes } = escenario([
      {
        codigo: '301',
        residentes: [ana],
        documento: {
          notificadosIds: [new Types.ObjectId(ana.accountId)],
          correosEnviadosIds: [new Types.ObjectId(ana.accountId)],
        },
      },
    ]);
    const { servicio, bloques } = montar({ documentos, residentes });
    bloques.findOne.mockReturnValue(
      consulta(
        bloqueDoc({
          estado: 'enviado',
          destinatariosTotal: 1,
          correoConfigurado: true,
        }),
      ),
    );

    const respuesta = await servicio.enviar(BLOQUE.toString(), user);

    expect(respuesta.estado).toBe('enviado');
    expect(respuesta.entrega).toEqual({
      destinatarios: 1,
      notificados: 1,
      correosEnviados: 1,
      correoConfigurado: true,
    });
    expect(respuesta.enviadoPor).toBe('Ana Administradora');
  });
});
