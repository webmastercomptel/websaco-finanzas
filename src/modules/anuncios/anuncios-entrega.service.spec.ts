import { ConflictException, NotFoundException } from '@nestjs/common';
import { Mongoose, Types } from 'mongoose';
import type { Destinatario } from '../../common/directorio/directorio.service';
import { AnuncioSchema } from '../../database/schemas/administracion/anuncio.schema';
import {
  AnunciosEntregaService,
  ENVIOS_SIMULTANEOS,
  VIGENCIA_ENVIO_MS,
} from './anuncios-entrega.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  return q;
};

/** Arguments of the n-th call of an untyped mock, typed as unknown. */
const llamada = (mock: jest.Mock, n = 0): unknown[] =>
  (mock.mock.calls as unknown[][])[n];

const COPROPIEDAD = new Types.ObjectId();
const ANUNCIO = new Types.ObjectId();

const anuncioDoc = (extra: Record<string, unknown> = {}) => ({
  _id: ANUNCIO,
  copropiedadId: COPROPIEDAD,
  titulo: 'Corte de agua',
  contenido: 'Hola {{nombre}}, el sábado no habrá agua.\nDisculpen.',
  categoria: 'mantenimiento',
  autor: 'Administración',
  imagenUrl: null,
  destacado: false,
  vistas: 0,
  meGustaIds: [] as Types.ObjectId[],
  estado: 'enviando',
  publicadoEn: new Date('2026-01-15T10:00:00.000Z'),
  notificadosIds: [] as Types.ObjectId[],
  correosEnviadosIds: [] as Types.ObjectId[],
  destinatariosTotal: 0,
  correoConfigurado: null,
  ...extra,
});

const residente = (n: number, nombre = `Residente ${n}`): Destinatario => ({
  accountId: new Types.ObjectId().toString(),
  email: `residente${n}@example.com`,
  nombre,
  perfil: 'residente',
});

interface LlamadaUpdateOne {
  filtro: Record<string, unknown>;
  cambio: Record<string, Record<string, unknown>>;
}

function montar(opciones: { correoConfigurado?: boolean } = {}) {
  const anuncios = {
    findOneAndUpdate: jest.fn().mockReturnValue(consulta(anuncioDoc())),
    findOne: jest.fn().mockReturnValue(consulta(anuncioDoc())),
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
  const residentes = [residente(1), residente(2)];
  const directorio = {
    residentes: jest
      .fn<Promise<Destinatario[]>, [Types.ObjectId]>()
      .mockResolvedValue(residentes),
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
      .fn<Promise<string | null>, [string, string, string]>()
      .mockResolvedValue('https://app.test/auth/enlace?token=abc'),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };

  const servicio = new AnunciosEntregaService(
    anuncios as never,
    copropiedades as never,
    tenant as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );

  const llamadasUpdateOne = (): LlamadaUpdateOne[] =>
    anuncios.updateOne.mock.calls.map(([filtro, cambio]) => ({
      filtro: filtro as Record<string, unknown>,
      cambio: cambio as Record<string, Record<string, unknown>>,
    }));
  /** Account ids recorded as delivered into `campo`, in order. */
  const registrados = (campo: string): string[] =>
    llamadasUpdateOne()
      .filter((l) => l.cambio.$addToSet && campo in l.cambio.$addToSet)
      .map((l) => String(l.cambio.$addToSet[campo]));
  /** The update that settles the state (the one that sets `estado`). */
  const finalizacion = (): LlamadaUpdateOne | undefined =>
    llamadasUpdateOne().find((l) => l.cambio.$set && 'estado' in l.cambio.$set);

  return {
    servicio,
    anuncios,
    copropiedades,
    tenant,
    residentes,
    directorio,
    correo,
    enlaces,
    notificaciones,
    registrados,
    finalizacion,
  };
}

describe('AnunciosEntregaService — reclamar', () => {
  it('toma el envío con UN update atómico filtrado por id Y copropiedad, solo desde estados reclamables', async () => {
    const { servicio, anuncios } = montar();

    await servicio.publicar(ANUNCIO.toString());

    const [filtro, pipeline, opciones] = anuncios.findOneAndUpdate.mock
      .calls[0] as [Record<string, unknown>, unknown[], unknown];
    expect(filtro._id).toBe(ANUNCIO.toString());
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    const alternativas = filtro.$or as Array<Record<string, unknown>>;
    // borrador y fallido se reclaman siempre; enviando solo si el lease venció;
    // enviado no aparece: es terminal.
    expect(alternativas[0]).toEqual({
      estado: { $in: ['borrador', 'fallido'] },
    });
    expect(alternativas[1]).toMatchObject({ estado: 'enviando' });
    expect(JSON.stringify(alternativas)).not.toContain('"enviado"');
    expect(Array.isArray(pipeline)).toBe(true);
    expect(opciones).toEqual({ new: true, updatePipeline: true });
  });

  it('el lease vencido se mide contra VIGENCIA_ENVIO_MS (y un enviando sin latido también se reclama)', async () => {
    const { servicio, anuncios } = montar();
    const antes = Date.now();

    await servicio.publicar(ANUNCIO.toString());

    const filtro = llamada(anuncios.findOneAndUpdate)[0] as {
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

  it('publicadoEn solo se estampa la primera vez ($ifNull) y el estado pasa a enviando con el token', async () => {
    const { servicio, anuncios } = montar();

    await servicio.publicar(ANUNCIO.toString());

    const pipeline = llamada(anuncios.findOneAndUpdate)[1] as Array<{
      $set: Record<string, unknown>;
    }>;
    expect(pipeline[0].$set.estado).toBe('enviando');
    expect(typeof pipeline[0].$set.tokenEnvio).toBe('string');
    expect(pipeline[0].$set.publicadoEn).toEqual({
      $ifNull: ['$publicadoEn', expect.any(Date)],
    });
  });

  it('acepta la forma real del update (Mongoose 9 valida opciones y pipeline al armar la consulta)', () => {
    const Anuncio = new Mongoose().model('Anuncio', AnuncioSchema);

    expect(() =>
      Anuncio.findOneAndUpdate(
        { _id: ANUNCIO, copropiedadId: COPROPIEDAD, estado: 'borrador' },
        [
          {
            $set: {
              estado: 'enviando',
              tokenEnvio: 'token',
              envioIniciadoEn: new Date(),
              publicadoEn: { $ifNull: ['$publicadoEn', new Date()] },
            },
          },
        ],
        { new: true, updatePipeline: true },
      ),
    ).not.toThrow();
  });

  it('un id mal formado es 404 sin tocar la base', async () => {
    const { servicio, anuncios } = montar();

    await expect(servicio.publicar('no-existe')).rejects.toThrow(
      NotFoundException,
    );
    expect(anuncios.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un anuncio inexistente (o de otra copropiedad) es 404', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(consulta(null));
    anuncios.findOne.mockReturnValue(consulta(null));

    await expect(servicio.publicar(ANUNCIO.toString())).rejects.toThrow(
      NotFoundException,
    );
    expect(anuncios.findOne).toHaveBeenCalledWith({
      _id: ANUNCIO.toString(),
      copropiedadId: COPROPIEDAD,
    });
  });

  it('un anuncio ya enviado es 409 y no entrega nada', async () => {
    const { servicio, anuncios, correo, notificaciones } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(consulta(null));
    anuncios.findOne.mockReturnValue(consulta({ estado: 'enviado' }));

    await expect(servicio.publicar(ANUNCIO.toString())).rejects.toThrow(
      /ya fue enviado/,
    );
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('dos publicaciones concurrentes: solo la que gana el claim entrega; la otra recibe 409', async () => {
    const { servicio, anuncios, correo } = montar();
    anuncios.findOneAndUpdate
      .mockReturnValueOnce(consulta(anuncioDoc()))
      .mockReturnValueOnce(consulta(null));
    // La lectura con `.select('estado')` es la de la perdedora; la lectura final
    // completa es la de la ganadora.
    anuncios.findOne.mockImplementation(() => {
      const q = consulta(anuncioDoc());
      q.select.mockReturnValue(consulta({ estado: 'enviando' }));
      return q;
    });

    const [ganadora, perdedora] = await Promise.allSettled([
      servicio.publicar(ANUNCIO.toString()),
      servicio.publicar(ANUNCIO.toString()),
    ]);

    expect(ganadora.status).toBe('fulfilled');
    expect(perdedora.status).toBe('rejected');
    if (perdedora.status === 'rejected') {
      expect(perdedora.reason).toBeInstanceOf(ConflictException);
      expect((perdedora.reason as Error).message).toMatch(/en proceso/);
    }
    // 2 residentes, un solo envío cada uno.
    expect(correo.enviar).toHaveBeenCalledTimes(2);
  });
});

describe('AnunciosEntregaService — entrega', () => {
  it('notifica dentro de la app y envía el correo a cada residente, y recién después lo registra como entregado', async () => {
    const { servicio, residentes, notificaciones, correo, registrados } =
      montar();

    await servicio.publicar(ANUNCIO.toString());

    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
    expect(notificaciones.crear).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      accountId: residentes[0].accountId,
      tipo: 'anuncio',
      titulo: 'Nuevo anuncio en Torres del Parque: Corte de agua',
    });
    expect(correo.enviar).toHaveBeenCalledTimes(2);
    expect(registrados('notificadosIds').sort()).toEqual(
      residentes.map((r) => r.accountId).sort(),
    );
    expect(registrados('correosEnviadosIds').sort()).toEqual(
      residentes.map((r) => r.accountId).sort(),
    );
  });

  it('registra el correo con $addToSet DESPUÉS de que el proveedor lo aceptó (nunca antes)', async () => {
    const { servicio, correo, anuncios } = montar();
    const orden: string[] = [];
    correo.enviar.mockImplementation(() => {
      orden.push('enviar');
      return Promise.resolve(true);
    });
    anuncios.updateOne.mockImplementation(
      (_filtro: unknown, cambio: Record<string, Record<string, unknown>>) => {
        if (cambio.$addToSet && 'correosEnviadosIds' in cambio.$addToSet) {
          orden.push('registrar');
        }
        return consulta({ matchedCount: 1 });
      },
    );

    await servicio.publicar(ANUNCIO.toString());

    // Por residente: enviar y luego registrar.
    expect(orden.indexOf('registrar')).toBeGreaterThan(orden.indexOf('enviar'));
    expect(orden.filter((o) => o === 'enviar')).toHaveLength(2);
    expect(orden.filter((o) => o === 'registrar')).toHaveLength(2);
  });

  it('cada registro filtra por id Y copropiedad', async () => {
    const { servicio, finalizacion, anuncios } = montar();

    await servicio.publicar(ANUNCIO.toString());

    for (const [filtro] of anuncios.updateOne.mock.calls as Array<
      [Record<string, unknown>]
    >) {
      expect(filtro._id).toBe(ANUNCIO);
      expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    }
    expect(finalizacion()?.cambio.$set).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 2,
      correoConfigurado: true,
      tokenEnvio: null,
      envioIniciadoEn: null,
    });
    expect(finalizacion()?.filtro.tokenEnvio).toEqual(expect.any(String));
  });

  it('el enlace de acceso apunta al portal del residente y un enlace nulo envía el correo sin botón', async () => {
    const { servicio, residentes, enlaces, correo } = montar();
    enlaces.construir.mockResolvedValueOnce(null);

    await servicio.publicar(ANUNCIO.toString());

    expect(enlaces.construir).toHaveBeenCalledWith(
      residentes[0].accountId,
      COPROPIEDAD.toString(),
      `/portal/anuncios?abrir=${ANUNCIO.toString()}`,
    );
    const htmls = correo.enviar.mock.calls.map(([m]) => m.html);
    expect(htmls.filter((h) => h.includes('Ver el anuncio'))).toHaveLength(1);
    expect(correo.enviar).toHaveBeenCalledTimes(2);
  });

  it('personaliza con el nombre del residente y ESCAPA el valor sustituido (sin inyección de HTML)', async () => {
    const { servicio, directorio, correo } = montar();
    directorio.residentes.mockResolvedValue([
      residente(1, '<img src=x onerror=alert(1)> & "Co"'),
    ]);

    await servicio.publicar(ANUNCIO.toString());

    const html = correo.enviar.mock.calls[0][0].html;
    expect(html).not.toContain('<img');
    expect(html).toContain(
      '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;',
    );
    // Un solo escape: no hay "&amp;lt;".
    expect(html).not.toContain('&amp;lt;');
    // El salto de línea del contenido se preserva.
    expect(html).toContain('<br/>');
  });

  it('sin residentes con cuenta el anuncio queda enviado (no hay nada pendiente)', async () => {
    const { servicio, directorio, finalizacion, correo } = montar();
    directorio.residentes.mockResolvedValue([]);

    await servicio.publicar(ANUNCIO.toString());

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(finalizacion()?.cambio.$set).toMatchObject({
      estado: 'enviado',
      destinatariosTotal: 0,
    });
  });

  it('la misma cuenta repetida en la audiencia recibe un solo aviso', async () => {
    const { servicio, directorio, notificaciones, correo } = montar();
    const ana = residente(1, 'Ana');
    directorio.residentes.mockResolvedValue([
      ana,
      { ...ana, perfil: 'personal' },
      residente(2),
    ]);

    await servicio.publicar(ANUNCIO.toString());

    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
    expect(correo.enviar).toHaveBeenCalledTimes(2);
  });
});

describe('AnunciosEntregaService — idempotencia y reanudación', () => {
  it('no vuelve a enviar a quien ya recibió todo (reenvío idempotente)', async () => {
    const { servicio, anuncios, residentes, notificaciones, correo, enlaces } =
      montar();
    const [ya, falta] = residentes;
    anuncios.findOneAndUpdate.mockReturnValue(
      consulta(
        anuncioDoc({
          notificadosIds: [new Types.ObjectId(ya.accountId)],
          correosEnviadosIds: [new Types.ObjectId(ya.accountId)],
        }),
      ),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(correo.enviar.mock.calls[0][0].para).toBe(falta.email);
    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
    expect(enlaces.construir).toHaveBeenCalledTimes(1);
    expect(enlaces.construir.mock.calls[0][0]).toBe(falta.accountId);
  });

  it('si todos ya recibieron todo no envía nada y deja el anuncio enviado', async () => {
    const {
      servicio,
      anuncios,
      residentes,
      correo,
      notificaciones,
      finalizacion,
    } = montar();
    const ids = residentes.map((r) => new Types.ObjectId(r.accountId));
    anuncios.findOneAndUpdate.mockReturnValue(
      consulta(anuncioDoc({ notificadosIds: ids, correosEnviadosIds: ids })),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
    expect(finalizacion()?.cambio.$set.estado).toBe('enviado');
  });

  it('un fallo parcial deja fallido; volver a publicar solo completa lo que faltaba', async () => {
    const montado = montar();
    const { servicio, anuncios, residentes, correo, notificaciones } = montado;
    const [bueno, malo] = residentes;
    correo.enviar.mockImplementation(({ para }) =>
      Promise.resolve(para !== malo.email),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(montado.finalizacion()?.cambio.$set.estado).toBe('fallido');
    expect(montado.registrados('correosEnviadosIds')).toEqual([
      bueno.accountId,
    ]);
    // El malo SÍ quedó notificado dentro de la app: ese avance se conserva.
    expect(montado.registrados('notificadosIds')).toContain(malo.accountId);

    // Segundo intento: el documento ya trae el avance del primero.
    jest.clearAllMocks();
    correo.enviar.mockResolvedValue(true);
    anuncios.findOneAndUpdate.mockReturnValue(
      consulta(
        anuncioDoc({
          estado: 'fallido',
          notificadosIds: residentes.map(
            (r) => new Types.ObjectId(r.accountId),
          ),
          correosEnviadosIds: [new Types.ObjectId(bueno.accountId)],
        }),
      ),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(correo.enviar.mock.calls[0][0].para).toBe(malo.email);
    expect(notificaciones.crear).not.toHaveBeenCalled();
    expect(montado.finalizacion()?.cambio.$set.estado).toBe('enviado');
  });

  it('una petición que murió a medias (enviando con avance) se completa al publicar de nuevo, sin duplicar', async () => {
    const { servicio, anuncios, residentes, correo, notificaciones } = montar();
    const [primero] = residentes;
    // Murió después de notificar y enviar al primero, antes de tocar al segundo.
    anuncios.findOneAndUpdate.mockReturnValue(
      consulta(
        anuncioDoc({
          estado: 'enviando',
          notificadosIds: [new Types.ObjectId(primero.accountId)],
          correosEnviadosIds: [new Types.ObjectId(primero.accountId)],
        }),
      ),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(correo.enviar.mock.calls.map(([m]) => m.para)).toEqual([
      residentes[1].email,
    ]);
    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('el fallo de un destinatario (correo que lanza, notificación que lanza) no frena a los demás', async () => {
    const { servicio, directorio, correo, notificaciones, finalizacion } =
      montar();
    const lista = [residente(1), residente(2), residente(3)];
    directorio.residentes.mockResolvedValue(lista);
    correo.enviar.mockImplementation(({ para }) =>
      para === lista[0].email
        ? Promise.reject(new Error('boom correo'))
        : Promise.resolve(true),
    );
    notificaciones.crear.mockImplementation(
      ({ accountId }: { accountId: string }) =>
        accountId === lista[1].accountId
          ? Promise.reject(new Error('boom inbox'))
          : Promise.resolve(),
    );

    await expect(servicio.publicar(ANUNCIO.toString())).resolves.toBeDefined();

    // El 3 recibió todo; el 1 y el 2 quedaron pendientes.
    expect(correo.enviar.mock.calls.map(([m]) => m.para)).toContain(
      lista[2].email,
    );
    expect(finalizacion()?.cambio.$set.estado).toBe('fallido');
  });

  it('si falla la escritura del avance, el destinatario queda pendiente (no se da por entregado)', async () => {
    const { servicio, anuncios, finalizacion } = montar();
    anuncios.updateOne.mockImplementation(
      (_f: unknown, cambio: Record<string, Record<string, unknown>>) =>
        cambio.$addToSet
          ? { exec: jest.fn().mockRejectedValue(new Error('mongo caído')) }
          : consulta({ matchedCount: 1 }),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(finalizacion()?.cambio.$set.estado).toBe('fallido');
  });

  it('un error inesperado (la audiencia no se pudo resolver) suelta el lease en fallido y se propaga', async () => {
    const { servicio, directorio, anuncios } = montar();
    directorio.residentes.mockRejectedValue(new Error('directorio caído'));

    await expect(servicio.publicar(ANUNCIO.toString())).rejects.toThrow(
      'directorio caído',
    );

    const token = (
      llamada(anuncios.findOneAndUpdate)[1] as Array<{
        $set: { tokenEnvio: string };
      }>
    )[0].$set.tokenEnvio;
    expect(anuncios.updateOne).toHaveBeenCalledWith(
      { _id: ANUNCIO, copropiedadId: COPROPIEDAD, tokenEnvio: token },
      {
        $set: { estado: 'fallido', tokenEnvio: null, envioIniciadoEn: null },
      },
    );
  });
});

describe('AnunciosEntregaService — correo no configurado', () => {
  it('crea las notificaciones dentro de la app, no intenta enviar correo y no finge éxito', async () => {
    const {
      servicio,
      correo,
      notificaciones,
      enlaces,
      finalizacion,
      registrados,
    } = montar({ correoConfigurado: false });

    const resultado = await servicio.publicar(ANUNCIO.toString());

    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(enlaces.construir).not.toHaveBeenCalled();
    expect(registrados('correosEnviadosIds')).toEqual([]);
    expect(finalizacion()?.cambio.$set).toMatchObject({
      estado: 'fallido',
      correoConfigurado: false,
    });
    expect(resultado).toBeDefined();
  });

  it('cuando el correo se configura, volver a publicar manda solo los correos y no repite las notificaciones', async () => {
    const { servicio, anuncios, residentes, correo, notificaciones } = montar();
    anuncios.findOneAndUpdate.mockReturnValue(
      consulta(
        anuncioDoc({
          estado: 'fallido',
          notificadosIds: residentes.map(
            (r) => new Types.ObjectId(r.accountId),
          ),
        }),
      ),
    );

    await servicio.publicar(ANUNCIO.toString());

    expect(notificaciones.crear).not.toHaveBeenCalled();
    expect(correo.enviar).toHaveBeenCalledTimes(2);
  });
});

describe('AnunciosEntregaService — lotes y lease', () => {
  it('nunca hay más de 10 envíos en vuelo y todos los residentes se procesan', async () => {
    const { servicio, directorio, correo } = montar();
    const total = 25;
    directorio.residentes.mockResolvedValue(
      Array.from({ length: total }, (_, i) => residente(i)),
    );
    let enVuelo = 0;
    let maximo = 0;
    correo.enviar.mockImplementation(async () => {
      enVuelo += 1;
      maximo = Math.max(maximo, enVuelo);
      await new Promise<void>((resolver) => setImmediate(resolver));
      enVuelo -= 1;
      return true;
    });

    await servicio.publicar(ANUNCIO.toString());

    expect(ENVIOS_SIMULTANEOS).toBe(10);
    expect(correo.enviar).toHaveBeenCalledTimes(total);
    expect(maximo).toBe(10);
  });

  it('renueva el lease después de cada lote', async () => {
    const { servicio, directorio, anuncios } = montar();
    directorio.residentes.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => residente(i)),
    );

    await servicio.publicar(ANUNCIO.toString());

    const latidos = (
      anuncios.updateOne.mock.calls as Array<
        [Record<string, unknown>, Record<string, Record<string, unknown>>]
      >
    ).filter(
      ([, cambio]) =>
        cambio.$set &&
        'envioIniciadoEn' in cambio.$set &&
        !('estado' in cambio.$set),
    );
    expect(latidos).toHaveLength(3);
  });

  it('si pierde el lease (o borraron el anuncio) deja de entregar y no cierra el estado', async () => {
    const { servicio, directorio, anuncios, correo, finalizacion } = montar();
    directorio.residentes.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => residente(i)),
    );
    anuncios.updateOne.mockImplementation(
      (_f: unknown, cambio: Record<string, Record<string, unknown>>) =>
        consulta({
          matchedCount: cambio.$set && 'envioIniciadoEn' in cambio.$set ? 0 : 1,
        }),
    );

    await servicio.publicar(ANUNCIO.toString());

    // Solo alcanzó a procesar el primer lote.
    expect(correo.enviar).toHaveBeenCalledTimes(10);
    expect(finalizacion()).toBeUndefined();
  });

  it('si el anuncio fue borrado durante el envío, la respuesta final es 404', async () => {
    const { servicio, anuncios } = montar();
    anuncios.findOne.mockReturnValue(consulta(null));

    await expect(servicio.publicar(ANUNCIO.toString())).rejects.toThrow(
      NotFoundException,
    );
  });
});
