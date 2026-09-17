import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { SaldosInicialesAnticipoService } from './saldos-iniciales-anticipo.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ProgresoImportacionService } from '../inmuebles/progreso-importacion.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const HOLDER = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();

const sesionFalsa = () => ({
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const progresoFalso = (): ProgresoImportacionService =>
  ({
    intervalo: jest.fn(() => 1),
    iniciar: jest.fn(() => Promise.resolve(undefined)),
    actualizar: jest.fn(() => Promise.resolve(undefined)),
    finalizar: jest.fn(() => Promise.resolve(undefined)),
    obtener: jest.fn(() => Promise.resolve(null)),
  }) as unknown as ProgresoImportacionService;

/**
 * Builds the service with in-memory backing state for
 * `saldos_iniciales_anticipo` and `saldos_documento_origen` — same
 * "shared-state, not one-shot stubs" discipline as `NotasAnticipoService`'s
 * own spec, since `listar`/`anular` both need to see what `importar` wrote.
 */
const construirServicio = () => {
  const documentos: Record<string, unknown>[] = [];
  const saldosOrigen: Record<string, unknown>[] = [];

  const saldosInicialesAnticipo = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      const creados = filas.map((f) => ({ _id: new Types.ObjectId(), ...f }));
      documentos.push(...creados);
      return Promise.resolve(creados);
    }),
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      exec: () => Promise.resolve(documentos),
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          documentos.find((d) => String(d._id) === String(filtro._id)) ?? null,
        ),
    })),
    updateOne: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          const doc = documentos.find(
            (d) => String(d._id) === String(filtro._id),
          );
          if (doc) Object.assign(doc, update.$set);
          return Promise.resolve(doc ?? null);
        },
      }),
    ),
  };

  const saldoDocumentoOrigen = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      const creados = filas.map((f) => ({ ...f }));
      saldosOrigen.push(...creados);
      return Promise.resolve(creados);
    }),
    find: jest.fn((filtro: { documentoId?: { $in: unknown[] } }) => ({
      exec: () => {
        const ids = (filtro.documentoId?.$in ?? []).map(String);
        return Promise.resolve(
          saldosOrigen.filter((s) => ids.includes(String(s.documentoId))),
        );
      },
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          saldosOrigen.find(
            (s) => String(s.documentoId) === String(filtro.documentoId),
          ) ?? null,
        ),
    })),
    updateOne: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          const fila = saldosOrigen.find(
            (s) => String(s.documentoId) === String(filtro.documentoId),
          );
          if (fila) Object.assign(fila, update.$set);
          return Promise.resolve(fila ?? null);
        },
      }),
    ),
  };

  const lotes = {
    create: jest.fn((filas: Record<string, unknown>[]) =>
      Promise.resolve(filas.map((f) => ({ _id: new Types.ObjectId(), ...f }))),
    ),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };

  let nextNumber = 0;
  const consecutivos = {
    findOneAndUpdate: jest.fn(() => ({
      exec: () => {
        nextNumber += 1;
        return Promise.resolve({ nextNumber });
      },
    })),
  };

  const copropiedades = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: '0001' }),
    })),
  };

  const inmuebles = {
    findOne: jest.fn(() => ({
      exec: () =>
        Promise.resolve({
          _id: INMUEBLE,
          code: 'AP-101',
          holderId: HOLDER,
        }),
    })),
    find: jest.fn(() => ({
      exec: () =>
        Promise.resolve([{ _id: INMUEBLE, code: 'AP-101', holderId: HOLDER }]),
    })),
  };

  const session = sesionFalsa();
  const service = new SaldosInicialesAnticipoService(
    saldosInicialesAnticipo as never,
    lotes as never,
    consecutivos as never,
    copropiedades as never,
    inmuebles as never,
    saldoDocumentoOrigen as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    progresoFalso(),
    conexionCon(session),
  );

  return { service, documentos, saldosOrigen };
};

const filaValida = (over: Record<string, unknown> = {}) => ({
  codigoCopropiedad: '0001',
  codigoInmueble: 'AP-101',
  tipoDocumento: 'RC',
  numero: '4152',
  fecha: '2026-01-01',
  valor: 300000,
  ...over,
});

describe('SaldosInicialesAnticipoService.importar', () => {
  it('crea el documento y su fila de SaldoDocumentoOrigen con saldoDisponible igual al valor importado', async () => {
    const { service, documentos, saldosOrigen } = construirServicio();

    const resultado = await service.importar(CUENTA, {
      filas: [filaValida()],
    });

    expect(resultado.importados).toBe(1);
    expect(resultado.errores).toHaveLength(0);
    expect(documentos).toHaveLength(1);
    expect(documentos[0]).toMatchObject({
      tipoDocumentoOriginal: 'RC',
      numeroOriginal: '4152',
      fullNumber: 'RC 4152',
      montoOriginal: 300000,
      terceroId: HOLDER,
    });
    expect(saldosOrigen).toHaveLength(1);
    expect(saldosOrigen[0]).toMatchObject({
      tipoDocumento: 'SI',
      montoOriginal: 300000,
      saldoDisponible: 300000,
    });
  });

  it('reporta la fila con error sin abortar el resto cuando el código de copropiedad no coincide', async () => {
    const { service, documentos } = construirServicio();

    const resultado = await service.importar(CUENTA, {
      filas: [filaValida({ codigoCopropiedad: 'OTRA' }), filaValida()],
    });

    expect(resultado.importados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0].fila).toBe(1);
    expect(documentos).toHaveLength(1);
  });
});

describe('SaldosInicialesAnticipoService.listar', () => {
  it('resuelve saldoDisponible desde SaldoDocumentoOrigen, nunca desde el documento en sí', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, { filas: [filaValida()] });

    const [item] = await service.listar();

    expect(item.saldoDisponible).toBe(300000);
    expect(item.monto).toBe(300000);
    expect(item.inmuebleCodigo).toBe('AP-101');
  });
});

describe('SaldosInicialesAnticipoService.anular', () => {
  it('pone en cero el saldo disponible restante y marca el documento anulado', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, { filas: [filaValida()] });
    const [{ id }] = await service.listar();

    const anulado = await service.anular(
      id,
      { motivo: 'duplicado', detalle: 'Fila duplicada del mismo archivo' },
      CUENTA,
    );

    expect(anulado.estado).toBe('anulado');
    expect(anulado.saldoDisponible).toBe(0);
  });

  it('lanza ConflictException si ya está anulado', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, { filas: [filaValida()] });
    const [{ id }] = await service.listar();

    await service.anular(
      id,
      { motivo: 'otro', detalle: 'Detalle de prueba con longitud suficiente' },
      CUENTA,
    );

    await expect(
      service.anular(
        id,
        {
          motivo: 'otro',
          detalle: 'Detalle de prueba con longitud suficiente',
        },
        CUENTA,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lanza NotFoundException si el documento no existe', async () => {
    const { service } = construirServicio();

    await expect(
      service.anular(
        new Types.ObjectId().toString(),
        {
          motivo: 'otro',
          detalle: 'Detalle de prueba con longitud suficiente',
        },
        CUENTA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
