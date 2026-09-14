import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LoteRecibosService } from './lote-recibos.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { RecibosService } from './recibos.service';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const tenantQueDevuelve = (id: Types.ObjectId): TenantContextService =>
  ({ resolveCoPropertyId: () => id }) as unknown as TenantContextService;

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  code: '301',
  holderId: new Types.ObjectId(),
  ...over,
});

/** A hand-rolled Mongoose-document-shaped lote — mutable in place (like a
 *  real Mongoose document), with `save()`/`markModified()` no-ops that just
 *  track calls, matching this repo's own "shared-state, not one-shot
 *  stubs" discipline for services that mutate a fetched document. */
const loteDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  number: 1,
  status: 'cargado',
  creadoEn: new Date('2026-06-10T14:30:00.000Z'),
  codigo: 'RC',
  medioPago: 'transferencia',
  cuentaDestino: '111005',
  totalDigitado: 0,
  filas: [] as Record<string, unknown>[],
  generatedBy: CUENTA,
  markModified: jest.fn(),
  save: jest.fn(function (this: Record<string, unknown>) {
    return Promise.resolve(this);
  }),
  ...over,
});

const construirServicio = (opciones: {
  lote?: Record<string, unknown> | null;
  lotes?: Record<string, unknown>[];
  inmuebles?: Record<string, unknown>[];
  copropiedad?: Record<string, unknown> | null;
  recibosCreados?: Record<string, unknown>[];
  crearRecibo?: jest.Mock;
  yaHayUno?: boolean;
}) => {
  const lotesModelo = {
    exists: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.yaHayUno ?? false),
    })),
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.lote ?? null),
    })),
    find: jest.fn(() => ({
      sort: () => ({ exec: () => Promise.resolve(opciones.lotes ?? []) }),
    })),
    findOneAndUpdate: jest.fn(
      (_filtro: unknown, _update: unknown, _opts?: unknown) => ({
        exec: () => Promise.resolve(opciones.lote ?? null),
      }),
    ),
    create: jest.fn((datos: Record<string, unknown>) =>
      Promise.resolve({ ...loteDoc(), ...datos }),
    ),
    deleteOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };

  const consecutivos = {
    findOneAndUpdate: jest.fn(() => ({
      exec: () => Promise.resolve({ nextNumber: 1 }),
    })),
  };

  const inmuebles = {
    find: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.inmuebles ?? []),
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      exec: () =>
        Promise.resolve(
          (opciones.inmuebles ?? []).find(
            (i) => String(i._id) === String(filtro._id),
          ) ?? null,
        ),
    })),
  };

  const recibosModelo = {
    find: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.recibosCreados ?? []),
    })),
  };

  const copropiedades = {
    findById: jest.fn(() => ({
      exec: () =>
        Promise.resolve(
          'copropiedad' in opciones ? opciones.copropiedad : { code: '0001' },
        ),
    })),
  };

  const recibosService = {
    crear:
      opciones.crearRecibo ??
      jest.fn(() => Promise.resolve({ id: new Types.ObjectId().toString() })),
  } as unknown as RecibosService;

  const service = new LoteRecibosService(
    lotesModelo as never,
    consecutivos as never,
    inmuebles as never,
    recibosModelo as never,
    copropiedades as never,
    tenantQueDevuelve(COP),
    recibosService,
  );

  return { service, lotesModelo, recibosService };
};

describe('LoteRecibosService.crear', () => {
  it('rechaza cuando ya hay un lote en curso (borrador o cargado)', async () => {
    const { service } = construirServicio({ yaHayUno: true });

    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'RC',
        medioPago: 'transferencia',
        totalDigitado: 100000,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea el lote en estado borrador', async () => {
    const { service } = construirServicio({});

    const resultado = await service.crear(CUENTA.toString(), {
      codigo: 'RC',
      medioPago: 'transferencia',
      totalDigitado: 100000,
    });

    expect(resultado.estado).toBe('borrador');
    expect(resultado.totalDigitado).toBe(100000);
  });
});

describe('LoteRecibosService.cargarArchivo', () => {
  it('resuelve inmuebleId cuando el código existe en la copropiedad activa', async () => {
    const inmueble = inmuebleDoc({ code: '301' });
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicio({
      lote,
      inmuebles: [inmueble],
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '301',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      {
        $set: {
          filas: { inmuebleId: Types.ObjectId | null; error: string | null }[];
        };
      },
    ];
    expect(update.$set.filas[0].inmuebleId).toEqual(inmueble._id);
    expect(update.$set.filas[0].error).toBeNull();
  });

  it('marca en error una fila cuyo código de inmueble no existe', async () => {
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicio({ lote, inmuebles: [] });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '999',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: { filas: { error: string | null }[] } },
    ];
    expect(update.$set.filas[0].error).toMatch(/no existe/);
  });

  it('marca en error una fila cuyo código de copropiedad no coincide con la activa', async () => {
    const inmueble = inmuebleDoc({ code: '301' });
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicio({
      lote,
      inmuebles: [inmueble],
      copropiedad: { code: '0001' },
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '301',
          copropiedadCodigo: '0002',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: { filas: { error: string | null }[] } },
    ];
    expect(update.$set.filas[0].error).toMatch(/no coincide/);
  });

  it('marca en error un inmueble sin titular asignado', async () => {
    const inmueble = inmuebleDoc({ code: '301', holderId: null });
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicio({
      lote,
      inmuebles: [inmueble],
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '301',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: { filas: { error: string | null }[] } },
    ];
    expect(update.$set.filas[0].error).toMatch(/titular/);
  });

  it('rechaza cargar un archivo sobre un lote ya aplicado', async () => {
    const lote = loteDoc({ status: 'aplicado' });
    const { service } = construirServicio({ lote });

    await expect(
      service.cargarArchivo('lote-1', CUENTA.toString(), {
        filas: [
          {
            inmuebleCodigo: '301',
            fechaPago: '2026-06-02',
            valorRecibido: 100000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('LoteRecibosService.aplicar', () => {
  it('rechaza cuando la suma de las filas no coincide con el total digitado', async () => {
    const lote = loteDoc({
      totalDigitado: 999999,
      filas: [
        {
          inmuebleCodigo: '301',
          inmuebleId: new Types.ObjectId(),
          fechaPago: new Date('2026-06-02'),
          valorRecibido: 100000,
          reciboId: null,
          error: null,
        },
      ],
    });
    const { service } = construirServicio({ lote });

    await expect(
      service.aplicar('lote-1', CUENTA.toString()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('crea un Recibo por cada fila sin error, vía RecibosService.crear() con aplicacionAutomatica', async () => {
    const inmueble = inmuebleDoc({ code: '301' });
    const lote = loteDoc({
      totalDigitado: 100000,
      filas: [
        {
          inmuebleCodigo: '301',
          inmuebleId: inmueble._id,
          fechaPago: new Date('2026-06-02'),
          valorRecibido: 100000,
          reciboId: null,
          error: null,
        },
      ],
    });
    const crearRecibo = jest.fn(() =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );
    const { service } = construirServicio({
      lote,
      inmuebles: [inmueble],
      crearRecibo,
    });

    const resultado = await service.aplicar('lote-1', CUENTA.toString());

    expect(crearRecibo).toHaveBeenCalledWith(
      CUENTA.toString(),
      expect.objectContaining({
        codigo: 'RC',
        inmuebleId: inmueble._id.toString(),
        terceroId: inmueble.holderId.toString(),
        montoRecibido: 100000,
        aplicacionAutomatica: true,
      }),
    );
    expect(resultado.errores).toHaveLength(0);
    expect(resultado.lote.estado).toBe('aplicado');
  });

  it('best-effort: una fila que falla no bloquea las demás, y queda reportada', async () => {
    const inmuebleA = inmuebleDoc({ code: '301' });
    const inmuebleB = inmuebleDoc({ code: '302' });
    const lote = loteDoc({
      totalDigitado: 300000,
      filas: [
        {
          inmuebleCodigo: '301',
          inmuebleId: inmuebleA._id,
          fechaPago: new Date('2026-06-02'),
          valorRecibido: 100000,
          reciboId: null,
          error: null,
        },
        {
          inmuebleCodigo: '302',
          inmuebleId: inmuebleB._id,
          fechaPago: new Date('2026-06-02'),
          valorRecibido: 200000,
          reciboId: null,
          error: null,
        },
      ],
    });
    const crearRecibo = jest
      .fn()
      .mockRejectedValueOnce(new Error('El período contable está cerrado'))
      .mockResolvedValueOnce({ id: new Types.ObjectId().toString() });
    const { service } = construirServicio({
      lote,
      inmuebles: [inmuebleA, inmuebleB],
      crearRecibo,
    });

    const resultado = await service.aplicar('lote-1', CUENTA.toString());

    expect(crearRecibo).toHaveBeenCalledTimes(2);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]).toMatchObject({
      fila: 1,
      inmuebleCodigo: '301',
    });
    expect(resultado.lote.filas[0].error).toMatch(/período contable/);
    expect(resultado.lote.filas[1].reciboId).not.toBeNull();
    // Queda `cargado`, no `aplicado`, porque la fila 1 sigue sin resolverse.
    expect(resultado.lote.estado).toBe('cargado');
  });

  it('una fila que falló se puede reintentar y aplicar con éxito en una segunda llamada', async () => {
    const inmuebleA = inmuebleDoc({ code: '301' });
    const filaConErrorPrevio = {
      inmuebleCodigo: '301',
      inmuebleId: inmuebleA._id,
      fechaPago: new Date('2026-06-02'),
      valorRecibido: 100000,
      reciboId: null,
      error: 'El período contable está cerrado', // del intento anterior
    };
    const lote = loteDoc({
      totalDigitado: 100000,
      filas: [filaConErrorPrevio],
    });
    const crearRecibo = jest.fn(() =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );
    const { service } = construirServicio({
      lote,
      inmuebles: [inmuebleA],
      crearRecibo,
    });

    const resultado = await service.aplicar('lote-1', CUENTA.toString());

    expect(crearRecibo).toHaveBeenCalledTimes(1);
    expect(resultado.errores).toHaveLength(0);
    expect(resultado.lote.filas[0].error).toBeNull();
    expect(resultado.lote.estado).toBe('aplicado');
  });

  it('reintentar tras un error parcial es idempotente — no vuelve a crear un Recibo para la fila ya exitosa', async () => {
    const inmuebleA = inmuebleDoc({ code: '301' });
    const reciboYaCreado = new Types.ObjectId();
    const lote = loteDoc({
      totalDigitado: 100000,
      filas: [
        {
          inmuebleCodigo: '301',
          inmuebleId: inmuebleA._id,
          fechaPago: new Date('2026-06-02'),
          valorRecibido: 100000,
          reciboId: reciboYaCreado,
          error: null,
        },
      ],
    });
    const crearRecibo = jest.fn();
    const { service } = construirServicio({
      lote,
      inmuebles: [inmuebleA],
      crearRecibo,
    });

    const resultado = await service.aplicar('lote-1', CUENTA.toString());

    expect(crearRecibo).not.toHaveBeenCalled();
    expect(resultado.lote.estado).toBe('aplicado');
  });
});
