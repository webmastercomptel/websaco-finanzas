import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { InterfazComptableService } from './interfaz-comptable.service';
import { resolveAnchorId } from '../consultas/movimiento-contable.util';
import { tipoDocumentoDe } from '../adicion-contabilidad/resolucion-documentos.service';
import type { ResultadoComptable } from './comptable.client';
import type { PayloadComptable } from '../../contracts';

/* ── Fake in-memory models ────────────────────────────────────────
 * Just enough of Mongoose's query API for this service: equality (ObjectId
 * compared by value, undefined == null), $in, $ne, $gte, $lte, $or, sort,
 * $set/$inc updates and upserts.
 */

type Doc = Record<string, unknown>;

/** ObjectIds, dates and primitives compared by value; undefined == null. */
const clave = (v: unknown): string =>
  v instanceof Types.ObjectId
    ? v.toHexString()
    : v instanceof Date
      ? v.toISOString()
      : typeof v === 'string'
        ? v
        : JSON.stringify(v);
const igual = (a: unknown, b: unknown): boolean =>
  (a == null && b == null) || (a != null && b != null && clave(a) === clave(b));

const esOperador = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !(v instanceof Types.ObjectId) &&
  !(v instanceof Date) &&
  Object.keys(v).some((k) => k.startsWith('$'));

function coincide(doc: Doc, filtro: Doc): boolean {
  return Object.entries(filtro).every(([clave, cond]) => {
    if (clave === '$or') return (cond as Doc[]).some((f) => coincide(doc, f));
    const valor = doc[clave];
    if (esOperador(cond)) {
      return Object.entries(cond).every(([op, x]) => {
        switch (op) {
          case '$in':
            return (x as unknown[]).some((y) => igual(valor, y));
          case '$ne':
            return !igual(valor, x);
          case '$gte':
            return (valor as Date) >= (x as Date);
          case '$lte':
            return (valor as Date) <= (x as Date);
          default:
            throw new Error(`operador no soportado ${op}`);
        }
      });
    }
    return igual(valor, cond);
  });
}

const ordenarPor =
  (spec: Record<string, number>) =>
  (a: Doc, b: Doc): number => {
    for (const [clave, dir] of Object.entries(spec)) {
      const x = a[clave] as { valueOf(): number | string };
      const y = b[clave] as { valueOf(): number | string };
      const vx = clave === '_id' ? String(x) : x.valueOf();
      const vy = clave === '_id' ? String(y) : y.valueOf();
      if (vx < vy) return -dir;
      if (vx > vy) return dir;
    }
    return 0;
  };

function aplicar(doc: Doc, update: Doc): void {
  Object.assign(doc, (update.$set as Doc) ?? {});
  for (const [k, n] of Object.entries((update.$inc as Doc) ?? {})) {
    doc[k] = ((doc[k] as number) ?? 0) + (n as number);
  }
}

function modelo(docs: Doc[], opciones: { unicoPendiente?: boolean } = {}) {
  const consulta = (resultado: (orden?: Record<string, number>) => unknown) => {
    let orden: Record<string, number> | undefined;
    const q = {
      sort: (spec: Record<string, number>) => {
        orden = spec;
        return q;
      },
      session: () => q,
      select: () => q,
      lean: () => q,
      exec: () => Promise.resolve(resultado(orden)),
    };
    return q;
  };
  return {
    docs,
    find: jest.fn((filtro: Doc = {}) =>
      consulta((orden) => {
        const filas = docs.filter((d) => coincide(d, filtro));
        return orden ? [...filas].sort(ordenarPor(orden)) : filas;
      }),
    ),
    findOne: jest.fn((filtro: Doc) =>
      consulta(() => docs.find((d) => coincide(d, filtro)) ?? null),
    ),
    findById: jest.fn((id: unknown) =>
      consulta(() => docs.find((d) => igual(d._id, id)) ?? null),
    ),
    exists: jest.fn((filtro: Doc) =>
      consulta(() =>
        docs.some((d) => coincide(d, filtro)) ? { _id: 1 } : null,
      ),
    ),
    create: jest.fn((nuevos: Doc[]) => {
      const creados = nuevos.map((n) => {
        if (
          opciones.unicoPendiente &&
          n.estado === 'pendiente' &&
          docs.some(
            (d) =>
              d.estado === 'pendiente' &&
              igual(d.copropiedadId, n.copropiedadId),
          )
        ) {
          throw Object.assign(new Error('E11000'), { code: 11000 });
        }
        const doc: Doc = {
          motivoFallo: null,
          comptableLoteId: null,
          intervenidoMensaje: null,
          intervenidoEn: null,
          enviadoPor: null,
          enviadoPorNombre: null,
          enviadoEn: null,
          retiradoPor: null,
          retiradoPorNombre: null,
          retiradoEn: null,
          ...n,
          _id: new Types.ObjectId(),
          createdAt: new Date('2026-10-21T15:00:00.000Z'),
        };
        docs.push(doc);
        return doc;
      });
      return Promise.resolve(creados);
    }),
    findOneAndUpdate: jest.fn(
      (filtro: Doc, update: Doc, opts: { upsert?: boolean } = {}) =>
        consulta(() => {
          let doc = docs.find((d) => coincide(d, filtro));
          if (!doc && opts.upsert) {
            doc = { _id: new Types.ObjectId(), ...filtro };
            docs.push(doc);
          }
          if (!doc) return null;
          aplicar(doc, update);
          return doc;
        }),
    ),
    updateMany: jest.fn((filtro: Doc, update: Doc) => {
      const filas = docs.filter((d) => coincide(d, filtro));
      filas.forEach((d) => aplicar(d, update));
      return Promise.resolve({ modifiedCount: filas.length });
    }),
  };
}

/* ── Fixtures ──────────────────────────────────────────────────── */

const COP = new Types.ObjectId();
const OTRA_COP = new Types.ObjectId();
const EMPRESA = '670000000000000000000001';
const TITULAR_ID = new Types.ObjectId();
const ACTOR = {
  accountId: new Types.ObjectId().toString(),
  nombre: 'Contadora Pérez',
};

const anclas = {
  facturaId: null,
  reciboId: null,
  notaCreditoId: null,
  notaDebitoId: null,
  notaContableId: null,
  notaAnticipoId: null,
};

let numeroAncla = 0;
const asiento = (
  ancla: 'facturaId' | 'reciboId' | 'notaCreditoId',
  fecha: string,
  over: Doc = {},
): Doc => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  ...anclas,
  [ancla]: new Types.ObjectId(),
  numeroAncla: ++numeroAncla,
  fecha: new Date(fecha),
  movimientos: [
    {
      cuenta: '1305',
      tipo: 'debito',
      monto: 1000,
      descripcion: 'Cartera',
      tercero: '101',
    },
    { cuenta: '4170', tipo: 'credito', monto: 1000, descripcion: 'Ingreso' },
  ],
  contabilidadLoteId: null,
  contabilidadLoteDesmarcadoId: null,
  comptableLoteId: null,
  comptableLoteRetiradoId: null,
  ...over,
});

const respuestaOk: ResultadoComptable<never> = {
  tipo: 'ok',
  status: 201,
  datos: {
    simulado: false,
    loteId: 'LOTE-COMPTABLE-1',
    totalAsientos: 2,
    totalLineas: 4,
    totalDebitos: '2000.00',
    totalCreditos: '2000.00',
    tercerosNuevos: [],
  } as never,
};

interface Escenario {
  asientos?: Doc[];
  empresa?: string | null;
  configurado?: boolean;
  sinPeriodo?: boolean;
  inmuebles?: Doc[];
}

function crear(escenario: Escenario = {}) {
  const asientos = modelo(
    escenario.asientos ?? [
      asiento('facturaId', '2026-10-01'),
      asiento('reciboId', '2026-10-05'),
    ],
  );
  const lotes = modelo([], { unicoPendiente: true });
  const consecutivos = modelo([]);
  const copropiedades = modelo([
    {
      _id: COP,
      codigo: '0001',
      nombre: 'Torres del Parque',
      comptableEmpresaId:
        escenario.empresa === undefined ? EMPRESA : escenario.empresa,
    },
  ]);
  const inmuebles = modelo(
    escenario.inmuebles ?? [
      { copropiedadId: COP, codigo: '101', titularId: TITULAR_ID },
      { copropiedadId: OTRA_COP, codigo: '102', titularId: TITULAR_ID },
    ],
  );
  const terceros = modelo([
    {
      _id: TITULAR_ID,
      copropiedadId: COP,
      tipoPersona: 'natural',
      nombre: 'Ana Pérez',
      primerNombre: 'Ana',
      segundoNombre: null,
      primerApellido: 'Pérez',
      segundoApellido: null,
      razonSocial: null,
      tipoIdentificacion: '13',
      digitoVerificacion: null,
      emails: ['ana@example.com'],
      telefono: null,
      direccion: null,
      ciudad: null,
    },
  ]);
  const resolucion = {
    buildAnchorMap: jest.fn((filas: Doc[]) =>
      Promise.resolve(
        new Map(
          filas.map((a) => [
            resolveAnchorId(a as never).toString(),
            { prefix: tipoDocumentoDe(a as never), number: a.numeroAncla },
          ]),
        ),
      ),
    ),
    resolveConceptos: jest.fn(() => Promise.resolve(new Map())),
    resolverSaldosIniciales: jest.fn(() => Promise.resolve(new Map())),
  };
  const comptable = {
    configurado: jest.fn(() => escenario.configurado ?? true),
    enviarLote: jest.fn((): Promise<ResultadoComptable<unknown>> =>
      Promise.resolve(respuestaOk),
    ),
    retirarLote: jest.fn((): Promise<ResultadoComptable<unknown>> =>
      Promise.resolve({ tipo: 'ok', status: 200, datos: {} }),
    ),
  };
  const lotesFacturacion = {
    obtenerUltimoConsolidado: jest.fn(() =>
      Promise.resolve(
        escenario.sinPeriodo
          ? null
          : {
              periodoDesde: new Date('2026-10-01'),
              periodoHasta: new Date('2026-10-31'),
            },
      ),
    ),
  };
  const auditoria = { registrar: jest.fn(() => Promise.resolve()) };
  const connection = {
    startSession: () =>
      Promise.resolve({
        withTransaction: (fn: () => Promise<void>) => fn(),
        endSession: () => Promise.resolve(),
      }),
  };
  const service = new InterfazComptableService(
    asientos as never,
    lotes as never,
    consecutivos as never,
    copropiedades as never,
    inmuebles as never,
    terceros as never,
    resolucion as never,
    comptable as never,
    { resolveCoPropertyId: () => COP } as never,
    lotesFacturacion as never,
    connection as never,
    auditoria as never,
  );
  return {
    service,
    asientos,
    lotes,
    consecutivos,
    copropiedades,
    comptable,
    auditoria,
  };
}

/** The rawBody the service handed to the client, parsed back. */
const payloadEnviado = (
  comptable: ReturnType<typeof crear>['comptable'],
  llamada = 0,
): PayloadComptable =>
  JSON.parse(
    (
      comptable.enviarLote.mock.calls[llamada] as unknown as [string, string]
    )[1],
  ) as PayloadComptable;

const esperarConflicto = async (promesa: Promise<unknown>, codigo: string) => {
  const error = await promesa.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({ codigo });
};

/* ── Specs ─────────────────────────────────────────────────────── */

describe('InterfazComptableService.estado', () => {
  it('dice si el servidor está configurado y si la copropiedad tiene Empresa, sin lanzar', async () => {
    const { service } = crear({ configurado: false, empresa: null });

    await expect(service.estado()).resolves.toEqual({
      configurado: false,
      comptableEmpresaId: null,
      lotePendiente: null,
    });
  });
});

describe('InterfazComptableService.pendientes', () => {
  it('sin Empresa de Comptable responde 409 SIN_EMPRESA', async () => {
    const { service } = crear({ empresa: null });

    await esperarConflicto(service.pendientes(ACTOR), 'SIN_EMPRESA');
  });

  it('sin período consolidado responde 400, igual que la exportación CSV', async () => {
    const { service } = crear({ sinPeriodo: true });

    await expect(service.pendientes(ACTOR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('misma selección que MOVMES sobre su propia marca: ignora la marca del CSV, excluye lo ya enviado y lo de otras copropiedades, incluye lo retirado', async () => {
    const retirado = asiento('notaCreditoId', '2026-08-15', {
      comptableLoteRetiradoId: new Types.ObjectId(),
    });
    const { service } = crear({
      asientos: [
        asiento('facturaId', '2026-10-01', {
          contabilidadLoteId: new Types.ObjectId(),
        }),
        asiento('reciboId', '2026-10-05'),
        asiento('reciboId', '2026-10-06', {
          comptableLoteId: new Types.ObjectId(),
        }),
        asiento('reciboId', '2026-09-30'),
        asiento('reciboId', '2026-10-07', { copropiedadId: OTRA_COP }),
        retirado,
      ],
    });

    const pendientes = await service.pendientes(ACTOR);

    expect(pendientes).toMatchObject({
      comptableEmpresaId: EMPRESA,
      totalAsientos: 3,
      totalLineas: 6,
      totalDebitos: 3000,
      totalCreditos: 3000,
      porDocumento: [
        { documento: 'FV', asientos: 1, lineas: 2 },
        { documento: 'RC', asientos: 1, lineas: 2 },
        { documento: 'NC', asientos: 1, lineas: 2 },
      ],
      inmueblesSinTitular: [],
      lotePendiente: null,
    });
    expect(pendientes.payload!.asientos.map((a) => a.documento)).toEqual([
      'NC',
      'FV',
      'RC',
    ]);
  });

  it('la vista previa trae el JSON exacto, sin id de lote y con el siguiente número', async () => {
    const { service, lotes, consecutivos } = crear();

    const { payload } = await service.pendientes(ACTOR);

    expect(payload!.origen).toMatchObject({
      sistema: 'websaco-finanzas',
      copropiedadId: COP.toString(),
      loteOrigenId: null,
      numeroLote: 1,
      periodoDesde: '2026-10-01',
      generadoPor: ACTOR,
    });
    expect(payload!.asientos[0].movimientos[0].tercero).toMatchObject({
      identificacion: '101',
      nombre1: 'Ana',
      email: 'ana@example.com',
    });
    expect(lotes.docs).toHaveLength(0);
    expect(consecutivos.docs).toHaveLength(0);
  });

  it('lista los inmuebles sin titular; el titular se busca solo en esta copropiedad', async () => {
    const { service } = crear({
      asientos: [
        asiento('facturaId', '2026-10-01', {
          movimientos: [
            {
              cuenta: '1305',
              tipo: 'debito',
              monto: 5,
              descripcion: 'x',
              tercero: '102',
            },
            { cuenta: '4170', tipo: 'credito', monto: 5, descripcion: 'y' },
          ],
        }),
      ],
    });

    expect((await service.pendientes(ACTOR)).inmueblesSinTitular).toEqual([
      '102',
    ]);
  });

  it('sin nada por enviar devuelve totales en cero y sin JSON', async () => {
    const { service } = crear({ asientos: [] });

    expect(await service.pendientes(ACTOR)).toMatchObject({
      totalAsientos: 0,
      payload: null,
    });
  });
});

describe('InterfazComptableService.simular', () => {
  it('ok: devuelve el resumen de Comptable con simular=true y no escribe nada', async () => {
    const { service, comptable, lotes, consecutivos, asientos } = crear();
    const antes = JSON.stringify(asientos.docs);

    const resultado = await service.simular(ACTOR);

    expect(resultado).toMatchObject({ valido: true, errores: [] });
    expect(resultado.resumen).toMatchObject({ loteId: 'LOTE-COMPTABLE-1' });
    expect(comptable.enviarLote.mock.calls[0]).toEqual([
      EMPRESA,
      expect.any(String),
      true,
    ]);
    expect(lotes.docs).toHaveLength(0);
    expect(consecutivos.docs).toHaveLength(0);
    expect(JSON.stringify(asientos.docs)).toBe(antes);
  });

  it('rechazado: devuelve los errores de Comptable tal cual', async () => {
    const { service, comptable } = crear();
    comptable.enviarLote.mockResolvedValueOnce({
      tipo: 'rechazado',
      mensaje: 'El lote tiene errores',
      errores: [{ asiento: 'FV 1', motivo: 'Cuenta 1305 inexistente' }],
    });

    expect(await service.simular(ACTOR)).toEqual({
      valido: false,
      resumen: null,
      mensaje: 'El lote tiene errores',
      errores: [{ asiento: 'FV 1', motivo: 'Cuenta 1305 inexistente' }],
    });
  });

  it.each([
    ['firma', { tipo: 'firma' }, /COMPTABLE_HMAC_SECRET/],
    ['timeout', { tipo: 'timeout' }, /No hubo respuesta/],
    ['red', { tipo: 'red' }, /No hubo respuesta/],
    ['5xx', { tipo: 'inesperado', status: 503 }, /No hubo respuesta/],
  ])('%s: 502', async (_caso, respuesta, mensaje) => {
    const { service, comptable } = crear();
    comptable.enviarLote.mockResolvedValueOnce(respuesta as never);

    const intento = service.simular(ACTOR);
    await expect(intento).rejects.toBeInstanceOf(BadGatewayException);
    await expect(intento).rejects.toThrow(mensaje);
  });

  it('sin configuración: 409 NO_CONFIGURADO, sin llamar a Comptable', async () => {
    const { service, comptable } = crear({ configurado: false });

    await esperarConflicto(service.simular(ACTOR), 'NO_CONFIGURADO');
    expect(comptable.enviarLote).not.toHaveBeenCalled();
  });

  it('sin movimientos: 409 SIN_MOVIMIENTOS', async () => {
    const { service } = crear({ asientos: [] });

    await esperarConflicto(service.simular(ACTOR), 'SIN_MOVIMIENTOS');
  });
});

describe('InterfazComptableService.enviar', () => {
  it('ok: crea el lote, firma el JSON con su id como loteOrigenId, marca los asientos y audita', async () => {
    const { service, comptable, lotes, asientos, auditoria } = crear();

    const resultado = await service.enviar(ACTOR);

    expect(resultado.resultado).toBe('enviado');
    expect(resultado.lote).toMatchObject({
      numero: 1,
      estado: 'enviado',
      comptableLoteId: 'LOTE-COMPTABLE-1',
      totalAsientos: 2,
      totalLineas: 4,
      totalDebitos: 2000,
      enviadoPorNombre: ACTOR.nombre,
    });
    const lote = lotes.docs[0];
    const payload = payloadEnviado(comptable);
    expect(comptable.enviarLote.mock.calls[0]).toEqual([
      EMPRESA,
      expect.any(String),
      false,
    ]);
    expect(payload.origen).toMatchObject({
      loteOrigenId: String(lote._id),
      numeroLote: 1,
      generadoPor: ACTOR,
    });
    for (const a of asientos.docs) {
      expect(String(a.comptableLoteId)).toBe(String(lote._id));
      // The CSV stamp is never touched.
      expect(a.contabilidadLoteId).toBeNull();
    }
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'crear',
        entidadTipo: 'lote-comptable',
        entidadId: String(lote._id),
        entidadEtiqueta:
          'Lote 1 de Interfaz a Comptable de 0001 Torres del Parque enviado: 2 documentos',
      }),
      expect.anything(),
    );
  });

  it('duplicado (409 LOTE_YA_RECIBIDO): se reconcilia como enviado con el loteId de Comptable', async () => {
    const { service, comptable, asientos } = crear();
    comptable.enviarLote.mockResolvedValueOnce({
      tipo: 'duplicado',
      loteId: 'EXISTENTE',
      mensaje: null,
    });

    const resultado = await service.enviar(ACTOR);

    expect(resultado).toMatchObject({
      resultado: 'enviado',
      lote: { estado: 'enviado', comptableLoteId: 'EXISTENTE' },
    });
    expect(asientos.docs.every((a) => a.comptableLoteId)).toBe(true);
  });

  it('rechazado: el lote queda fallido con el motivo, nada se marca y el siguiente envío abre otro lote', async () => {
    const { service, comptable, asientos, lotes, auditoria } = crear();
    comptable.enviarLote.mockResolvedValueOnce({
      tipo: 'rechazado',
      mensaje: 'El lote tiene errores',
      errores: [{ asiento: 'FV 1', motivo: 'Mes cerrado' }],
    });

    const resultado = await service.enviar(ACTOR);

    expect(resultado).toMatchObject({
      resultado: 'fallido',
      mensaje: 'El lote tiene errores',
      errores: [{ asiento: 'FV 1', motivo: 'Mes cerrado' }],
      lote: {
        estado: 'fallido',
        motivoFallo: 'El lote tiene errores (1 error)',
      },
    });
    expect(asientos.docs.every((a) => a.comptableLoteId === null)).toBe(true);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'actualizar',
        entidadTipo: 'lote-comptable',
      }),
      expect.anything(),
    );

    const segundo = await service.enviar(ACTOR);
    expect(segundo.lote.numero).toBe(2);
    expect(lotes.docs).toHaveLength(2);
  });

  it('firma rechazada: fallido con la indicación de revisar el secreto', async () => {
    const { service, comptable } = crear();
    comptable.enviarLote.mockResolvedValueOnce({ tipo: 'firma' });

    const resultado = await service.enviar(ACTOR);

    expect(resultado.resultado).toBe('fallido');
    expect(resultado.lote.motivoFallo).toMatch(/COMPTABLE_HMAC_SECRET/);
  });

  it.each([
    ['timeout', { tipo: 'timeout' }],
    ['red', { tipo: 'red' }],
    ['5xx', { tipo: 'inesperado', status: 502 }],
    ['409 sin código reconocible', { tipo: 'conflicto', mensaje: 'raro' }],
  ])(
    '%s: el lote queda pendiente, nada se marca, y solo se puede reintentar el MISMO lote con los MISMOS asientos',
    async (_caso, respuesta) => {
      const { service, comptable, asientos, lotes } = crear();
      comptable.enviarLote.mockResolvedValueOnce(respuesta as never);

      const primero = await service.enviar(ACTOR);
      expect(primero).toMatchObject({
        resultado: 'pendiente',
        lote: { estado: 'pendiente' },
      });
      expect(primero.mensaje).toMatch(/Reintentar/);
      expect(asientos.docs.every((a) => a.comptableLoteId === null)).toBe(true);

      await esperarConflicto(service.enviar(ACTOR), 'LOTE_PENDIENTE');

      // A new entry appears meanwhile: the retry must not pick it up.
      asientos.docs.push(asiento('reciboId', '2026-10-20'));

      const reintento = await service.reintentar(primero.lote.id, ACTOR);

      expect(reintento.resultado).toBe('enviado');
      expect(lotes.docs).toHaveLength(1);
      const [primerEnvio, segundoEnvio] = [
        payloadEnviado(comptable, 0),
        payloadEnviado(comptable, 1),
      ];
      expect(segundoEnvio).toEqual(primerEnvio);
      expect(segundoEnvio.origen.loteOrigenId).toBe(primero.lote.id);
      expect(asientos.docs.filter((a) => a.comptableLoteId)).toHaveLength(2);
    },
  );

  it('inmuebles sin titular: 409 con la lista, sin crear lote ni llamar a Comptable', async () => {
    const { service, comptable, lotes } = crear({ inmuebles: [] });

    const error = (await service
      .enviar(ACTOR)
      .catch((e: unknown) => e)) as ConflictException;

    expect(error.getResponse()).toMatchObject({
      codigo: 'INMUEBLES_SIN_TITULAR',
      inmuebles: ['101'],
    });
    expect(lotes.docs).toHaveLength(0);
    expect(comptable.enviarLote).not.toHaveBeenCalled();
  });

  it('sin movimientos: 409 SIN_MOVIMIENTOS', async () => {
    const { service } = crear({ asientos: [] });

    await esperarConflicto(service.enviar(ACTOR), 'SIN_MOVIMIENTOS');
  });

  it('sin Empresa o sin configuración no crea nada', async () => {
    const sinEmpresa = crear({ empresa: null });
    await esperarConflicto(sinEmpresa.service.enviar(ACTOR), 'SIN_EMPRESA');
    expect(sinEmpresa.lotes.docs).toHaveLength(0);

    const sinConfig = crear({ configurado: false });
    await esperarConflicto(sinConfig.service.enviar(ACTOR), 'NO_CONFIGURADO');
    expect(sinConfig.lotes.docs).toHaveLength(0);
  });

  it('dos "Enviar" a la vez producen un solo lote', async () => {
    const { service, comptable, lotes } = crear();
    comptable.enviarLote.mockResolvedValue({ tipo: 'timeout' });

    const resultados = await Promise.allSettled([
      service.enviar(ACTOR),
      service.enviar(ACTOR),
    ]);

    expect(lotes.docs).toHaveLength(1);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rechazo = resultados.find((r) => r.status === 'rejected');
    expect(
      (
        (rechazo as PromiseRejectedResult).reason as ConflictException
      ).getResponse(),
    ).toMatchObject({ codigo: 'LOTE_PENDIENTE' });
  });

  it('una exportación CSV entre medias no cambia lo que va a Comptable', async () => {
    const { service, asientos } = crear();
    const antes = await service.pendientes(ACTOR);

    // What AdicionContabilidadService.generar writes.
    for (const a of asientos.docs) a.contabilidadLoteId = new Types.ObjectId();

    const despues = await service.pendientes(ACTOR);
    expect(despues.payload).toEqual(antes.payload);

    await service.enviar(ACTOR);
    expect(asientos.docs.every((a) => a.comptableLoteId)).toBe(true);
  });
});

describe('InterfazComptableService.reintentar', () => {
  it('solo un lote pendiente', async () => {
    const { service } = crear();
    const { lote } = await service.enviar(ACTOR);

    await expect(service.reintentar(lote.id, ACTOR)).rejects.toThrow(
      /no está pendiente/,
    );
  });

  it('un lote de otra copropiedad o un id inválido responde como inexistente', async () => {
    const { service, lotes } = crear();
    lotes.docs.push({
      _id: new Types.ObjectId(),
      copropiedadId: OTRA_COP,
      numero: 1,
      estado: 'pendiente',
    });

    await expect(
      service.reintentar(String(lotes.docs[0]._id), ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.reintentar('no-es-un-id', ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechazado al reintentar: queda fallido', async () => {
    const { service, comptable } = crear();
    comptable.enviarLote.mockResolvedValueOnce({ tipo: 'timeout' });
    const { lote } = await service.enviar(ACTOR);
    comptable.enviarLote.mockResolvedValueOnce({
      tipo: 'rechazado',
      mensaje: 'Período cerrado',
      errores: [],
    });

    const resultado = await service.reintentar(lote.id, ACTOR);

    expect(resultado).toMatchObject({
      resultado: 'fallido',
      lote: { estado: 'fallido', motivoFallo: 'Período cerrado' },
    });
  });
});

describe('InterfazComptableService.retirar', () => {
  const enviado = async () => {
    const contexto = crear();
    const { lote } = await contexto.service.enviar(ACTOR);
    contexto.auditoria.registrar.mockClear();
    return { ...contexto, lote };
  };

  it('ok: llama a Comptable primero, libera las marcas, deja el lote retirado y audita', async () => {
    const { service, comptable, asientos, lote, auditoria } = await enviado();

    const retirado = await service.retirar(lote.id, ACTOR);

    expect(comptable.retirarLote).toHaveBeenCalledWith(EMPRESA, lote.id, {
      accountId: ACTOR.accountId,
      nombre: ACTOR.nombre,
    });
    expect(retirado).toMatchObject({
      estado: 'retirado',
      retiradoPorNombre: ACTOR.nombre,
    });
    for (const a of asientos.docs) {
      expect(a.comptableLoteId).toBeNull();
      expect(String(a.comptableLoteRetiradoId)).toBe(lote.id);
    }
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'retirar',
        entidadTipo: 'lote-comptable',
        entidadEtiqueta: expect.stringContaining(
          'retirado de Comptable: 2 documentos vuelven a pendientes',
        ) as unknown,
      }),
      expect.anything(),
    );
  });

  it('ya retirado en Comptable (LOTE_YA_RETIRADO): es éxito, libera las marcas, deja el lote retirado y lo anota en la auditoría', async () => {
    const { service, comptable, asientos, lote, auditoria } = await enviado();
    comptable.retirarLote.mockResolvedValueOnce({
      tipo: 'yaRetirado',
      mensaje: 'Este lote ya fue retirado de Comptable',
    });

    const retirado = await service.retirar(lote.id, ACTOR);

    expect(retirado).toMatchObject({
      estado: 'retirado',
      retiradoPorNombre: ACTOR.nombre,
    });
    for (const a of asientos.docs) {
      expect(a.comptableLoteId).toBeNull();
      expect(String(a.comptableLoteRetiradoId)).toBe(lote.id);
    }
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'retirar',
        entidadEtiqueta: expect.stringContaining(
          'retirado (Comptable ya lo había retirado): 2 documentos vuelven a pendientes',
        ) as unknown,
      }),
      expect.anything(),
    );
  });

  it('lo retirado vuelve a pendientes aunque sea de otro período', async () => {
    const contexto = crear({
      asientos: [asiento('reciboId', '2026-10-05')],
    });
    const { lote } = await contexto.service.enviar(ACTOR);
    contexto.asientos.docs[0].fecha = new Date('2026-08-01');

    await contexto.service.retirar(lote.id, ACTOR);

    expect((await contexto.service.pendientes(ACTOR)).totalAsientos).toBe(1);
  });

  it('intervenido: 409 con el mensaje de Comptable tal cual; el lote sigue enviado con sus marcas y no se vuelve a preguntar', async () => {
    const { service, comptable, asientos, lote, lotes } = await enviado();
    const mensaje =
      'El lote fue modificado en Comptable el 21/10/2026 16:40 por Luis Gómez: ya no se puede retirar desde WebSACO Finanzas.';
    comptable.retirarLote.mockResolvedValueOnce({
      tipo: 'intervenido',
      mensaje,
    });

    const error = (await service
      .retirar(lote.id, ACTOR)
      .catch((e: unknown) => e)) as ConflictException;

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      codigo: 'LOTE_INTERVENIDO',
      message: mensaje,
    });
    expect(lotes.docs[0]).toMatchObject({
      estado: 'enviado',
      intervenidoMensaje: mensaje,
    });
    expect(asientos.docs.every((a) => a.comptableLoteId)).toBe(true);
    expect((await service.listar())[0]).toMatchObject({
      intervenido: true,
      intervenidoMensaje: mensaje,
    });

    await expect(service.retirar(lote.id, ACTOR)).rejects.toThrow(mensaje);
    expect(comptable.retirarLote).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'mes cerrado (otro 409)',
      { tipo: 'conflicto', mensaje: 'El mes 10/2026 está cerrado.' },
      ConflictException,
      'El mes 10/2026 está cerrado.',
    ],
    [
      'no existe en Comptable',
      { tipo: 'noEncontrado', mensaje: null },
      ConflictException,
      /Comptable no tiene el lote 1/,
    ],
    ['timeout', { tipo: 'timeout' }, BadGatewayException, /sigue enviado/],
    [
      'cuerpo rechazado (400)',
      {
        tipo: 'rechazado',
        mensaje: 'property otro should not exist',
        errores: [],
      },
      BadGatewayException,
      /rechazó la solicitud de retiro: property otro should not exist/,
    ],
    ['firma', { tipo: 'firma' }, BadGatewayException, /COMPTABLE_HMAC_SECRET/],
  ])(
    '%s: no cambia nada aquí',
    async (_caso, respuesta, tipoError, mensaje) => {
      const { service, comptable, asientos, lote, lotes } = await enviado();
      comptable.retirarLote.mockResolvedValueOnce(respuesta as never);

      const intento = service.retirar(lote.id, ACTOR);
      await expect(intento).rejects.toBeInstanceOf(tipoError);
      await expect(intento).rejects.toThrow(mensaje);
      expect(lotes.docs[0].estado).toBe('enviado');
      expect(asientos.docs.every((a) => a.comptableLoteId)).toBe(true);
    },
  );

  it('solo se retira un lote enviado', async () => {
    const { service, comptable } = crear();
    comptable.enviarLote.mockResolvedValueOnce({ tipo: 'timeout' });
    const { lote } = await service.enviar(ACTOR);

    await expect(service.retirar(lote.id, ACTOR)).rejects.toThrow(
      /no está enviado/,
    );
    expect(comptable.retirarLote).not.toHaveBeenCalled();
  });
});

describe('InterfazComptableService.listar', () => {
  it('solo los lotes de la copropiedad activa, del más reciente al más antiguo', async () => {
    const { service, lotes, comptable } = crear();
    comptable.enviarLote.mockResolvedValue({
      tipo: 'rechazado',
      mensaje: 'x',
      errores: [],
    });
    await service.enviar(ACTOR);
    await service.enviar(ACTOR);
    lotes.docs.push({
      _id: new Types.ObjectId(),
      copropiedadId: OTRA_COP,
      numero: 99,
      estado: 'enviado',
    });

    expect((await service.listar()).map((l) => l.numero)).toEqual([2, 1]);
  });
});
