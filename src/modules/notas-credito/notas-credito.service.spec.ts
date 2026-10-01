import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { NotasCreditoService } from './notas-credito.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();

/** Runs `fn` synchronously — no real transaction, matching how this whole
 *  repo's tests stub Mongoose (see recibos.service.spec.ts's own header). */
const sesionFalsa = () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const tenantQueDevuelve = (id: Types.ObjectId): TenantContextService =>
  ({ resolveCoPropertyId: () => id }) as unknown as TenantContextService;

const numeracionQueEntrega = (completo: string): NumeracionService =>
  ({
    siguienteDocumento: jest.fn(() =>
      Promise.resolve({ prefijo: 'NC', numero: 1, completo }),
    ),
  }) as unknown as NumeracionService;

/** No open Lote in any test here — the guard always passes. No consolidated
 *  Lote either, by default — `obtenerUltimoConsolidado` returning `null`
 *  means "nothing to validate the note's own `fecha` period against", same
 *  default `RecibosService.crear()`'s own spec uses for the identical check
 *  on `fechaRecibo`. Tests exercising the period-match validation pass their
 *  own `lotes` override. */
const lotesFacturacionFalso = (ultimoConsolidado: unknown = null) =>
  ({
    exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
    obtenerUltimoConsolidado: jest.fn(() => Promise.resolve(ultimoConsolidado)),
  }) as never;

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  terceroId: TERCERO,
  estado: 'emitida',
  numeroCompleto: 'FV-1',
  saldoPendiente: 200000,
  total: 200000,
  lineas: [{ conceptoId: CONCEPTO, valorTotal: 200000 }],
  ...over,
});

const modeloFacturas = (factura: Record<string, unknown>) => ({
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(factura) }),
  })),
  // Used by `findOne()`'s batch `numerosPorDocumento` resolution — never by
  // `crear()`/`aplicar()`, which only ever read one Factura at a time via
  // `findOne` above. The atomic guard itself lives on `SaldoTotalDocumento`
  // now (see `modeloSaldoTotalDocumento`) — `Factura` is immutable, so this
  // model never gets a `findOneAndUpdate` again.
  find: jest.fn(() => ({ exec: () => Promise.resolve([factura]) })),
});

/** Combined `SaldoTotalDocumento` mock, backed by whichever Factura fixtures
 *  the caller passes — same shared-mutable-state trick `modeloFacturas` used
 *  to run directly on `saldoPendiente`, just relocated off the (now
 *  immutable) Factura onto this collection instead. Mirrors
 *  `recibos.service.spec.ts`'s own helper of the same name. */
const modeloSaldoTotalDocumento = (documentos: Record<string, unknown>[]) => ({
  findOneAndUpdate: jest.fn(
    (
      filtro: Record<string, unknown>,
      update: { $inc?: { saldoPendiente: number } },
    ) => ({
      exec: () => {
        const doc = documentos.find(
          (d) => String(d._id) === String(filtro.documentoId),
        );
        if (!doc) return Promise.resolve(null);
        if (filtro.$expr) {
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if ((doc.saldoPendiente as number) < monto) {
            return Promise.resolve(null);
          }
          doc.saldoPendiente = (doc.saldoPendiente as number) - monto;
        } else if (update.$inc) {
          doc.saldoPendiente =
            (doc.saldoPendiente as number) + update.$inc.saldoPendiente;
        }
        return Promise.resolve({
          documentoId: doc._id,
          saldoPendiente: doc.saldoPendiente,
        });
      },
    }),
  ),
  findOne: jest.fn((filtro: Record<string, unknown>) => ({
    session: () => ({
      exec: () => {
        const doc = documentos.find(
          (d) => String(d._id) === String(filtro.documentoId),
        );
        return Promise.resolve(
          doc
            ? { documentoId: doc._id, saldoPendiente: doc.saldoPendiente }
            : null,
        );
      },
    }),
  })),
  find: jest.fn((filtro: { documentoId?: { $in: unknown[] } }) => ({
    session: () => ({
      exec: () => {
        const ids = (filtro.documentoId?.$in ?? []).map(String);
        return Promise.resolve(
          documentos
            .filter(
              (d) =>
                ids.includes(String(d._id)) && (d.saldoPendiente as number) > 0,
            )
            .map((d) => ({
              documentoId: d._id,
              saldoPendiente: d.saldoPendiente,
            })),
        );
      },
    }),
  })),
});

/** Single-document leniency variant of `modeloSaldoTotalDocumento`, mirroring
 *  `modeloFacturas`'s own long-standing leniency: `construirServicio` never
 *  ties its one `factura` fixture to the id `dtoBase()` happens to submit
 *  (`dtoBase().facturaId` is an independently-generated `ObjectId`, same as
 *  it always has been) — so, like `modeloFacturas`, this ignores whichever
 *  `documentoId` it's asked about and always answers for the one `factura`
 *  it was built with. Tests that DO need real per-id matching across two+
 *  documents (aplicar/anular against a specific OTHER factura) build their
 *  own `modeloSaldoTotalDocumento([...])` instead — this one is for
 *  `construirServicio` only. */
const modeloSaldoTotalDocumentoUnico = (factura: Record<string, unknown>) => ({
  findOneAndUpdate: jest.fn(
    (
      filtro: Record<string, unknown>,
      update: { $inc?: { saldoPendiente: number } },
    ) => ({
      exec: () => {
        if (filtro.$expr) {
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if ((factura.saldoPendiente as number) < monto) {
            return Promise.resolve(null);
          }
          factura.saldoPendiente = (factura.saldoPendiente as number) - monto;
        } else if (update.$inc) {
          factura.saldoPendiente =
            (factura.saldoPendiente as number) + update.$inc.saldoPendiente;
        }
        return Promise.resolve({
          documentoId: factura._id,
          saldoPendiente: factura.saldoPendiente,
        });
      },
    }),
  ),
  findOne: jest.fn(() => ({
    session: () => ({
      exec: () =>
        Promise.resolve({
          documentoId: factura._id,
          saldoPendiente: factura.saldoPendiente,
        }),
    }),
  })),
  find: jest.fn(() => ({
    session: () => ({
      exec: () =>
        Promise.resolve([
          {
            documentoId: factura._id,
            saldoPendiente: factura.saldoPendiente,
          },
        ]),
    }),
  })),
});

/** `SaldoDocumentoOrigen` mock, backed by whichever NotaCredito fixtures the
 *  caller passes — same shared-mutable-state trick `modeloSaldoTotalDocumento`
 *  uses, just for the SOURCE side (NotaCredito) instead of the charge side.
 *  Reuses each fixture's own `montoSinAplicar` as the live `saldoDisponible`
 *  and `montoTotal` as the frozen `montoOriginal`. Mirrors
 *  `recibos.service.spec.ts`'s own helper of the same name. */
const modeloSaldoDocumentoOrigen = (documentos: Record<string, unknown>[]) => ({
  create: jest.fn(() => Promise.resolve([{}])),
  findOneAndUpdate: jest.fn(
    (
      filtro: Record<string, unknown>,
      update: { $inc?: { saldoDisponible: number } },
    ) => ({
      exec: () => {
        const doc = documentos.find(
          (d) => String(d._id) === String(filtro.documentoId),
        );
        if (!doc) return Promise.resolve(null);
        if (filtro.$expr) {
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if ((doc.montoSinAplicar as number) < monto) {
            return Promise.resolve(null);
          }
          doc.montoSinAplicar = (doc.montoSinAplicar as number) - monto;
        } else if (update.$inc) {
          doc.montoSinAplicar =
            (doc.montoSinAplicar as number) + update.$inc.saldoDisponible;
        }
        return Promise.resolve({
          documentoId: doc._id,
          montoOriginal: doc.montoTotal,
          saldoDisponible: doc.montoSinAplicar,
        });
      },
    }),
  ),
  // `findOne` is called both ways: bare `.exec()` (`findOne()`/`findAll()`
  // service methods) and `.session(session).exec()` (`aplicar()`/`anular()`'s
  // own transactions) — `.session()` returns the same chainable object so
  // either call shape resolves.
  findOne: jest.fn((filtro: Record<string, unknown>) => {
    const resultado = (() => {
      const doc = documentos.find(
        (d) => String(d._id) === String(filtro.documentoId),
      );
      return doc
        ? {
            documentoId: doc._id,
            montoOriginal: doc.montoTotal,
            saldoDisponible: doc.montoSinAplicar,
          }
        : null;
    })();
    const cadena = {
      session: () => cadena,
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  }),
  updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  // Handles both query shapes `findAll` makes: the `conAnticipoDisponible`
  // candidate query (no `documentoId` filter, just `saldoDisponible: {$gt:
  // 0}`) and the post-page batch lookup (`documentoId: {$in: [...]}`).
  find: jest.fn((filtro: Record<string, unknown>) => ({
    exec: () => {
      const idsFiltro = (filtro.documentoId as { $in?: unknown[] } | undefined)
        ?.$in;
      const resultado = idsFiltro
        ? documentos.filter((d) =>
            idsFiltro.map(String).includes(String(d._id)),
          )
        : documentos.filter((d) => (d.montoSinAplicar as number) > 0);
      return Promise.resolve(
        resultado.map((d) => ({
          documentoId: d._id,
          saldoDisponible: d.montoSinAplicar,
        })),
      );
    },
  })),
});

/** Single-document leniency variant, mirroring `modeloSaldoTotalDocumentoUnico`
 *  — `construirServicio` never ties its one `notaCreada` fixture to a real
 *  matching id the same way `modeloSaldoTotalDocumentoUnico` doesn't for
 *  `factura`, so this ignores whichever `documentoId` it's asked about and
 *  always answers for the one `nota` it was built with. */
const modeloSaldoDocumentoOrigenUnico = (nota: Record<string, unknown>) => ({
  create: jest.fn(() => Promise.resolve([{}])),
  findOneAndUpdate: jest.fn(
    (
      filtro: Record<string, unknown>,
      update: { $inc?: { saldoDisponible: number } },
    ) => ({
      exec: () => {
        if (filtro.$expr) {
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if ((nota.montoSinAplicar as number) < monto) {
            return Promise.resolve(null);
          }
          nota.montoSinAplicar = (nota.montoSinAplicar as number) - monto;
        } else if (update.$inc) {
          nota.montoSinAplicar =
            (nota.montoSinAplicar as number) + update.$inc.saldoDisponible;
        }
        return Promise.resolve({
          documentoId: nota._id,
          montoOriginal: nota.montoTotal,
          saldoDisponible: nota.montoSinAplicar,
        });
      },
    }),
  ),
  findOne: jest.fn(() => {
    const resultado = {
      documentoId: nota._id,
      montoOriginal: nota.montoTotal,
      saldoDisponible: nota.montoSinAplicar,
    };
    const cadena = {
      session: () => cadena,
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  }),
  updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  find: jest.fn(() => ({
    exec: () =>
      Promise.resolve([
        { documentoId: nota._id, saldoDisponible: nota.montoSinAplicar },
      ]),
  })),
});

const modeloNotasCredito = (
  creada: Record<string, unknown>,
  // Every OTHER active Nota Crédito already issued against the anchor
  // invoice, as `crear()`'s own cumulative-cap check reads them — empty by
  // default so every existing test (none of which cares about that check)
  // keeps seeing "nothing credited yet".
  notasPrevias: Record<string, unknown>[] = [],
) => ({
  create: jest.fn(() => Promise.resolve([creada])),
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(creada) }),
  })),
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(creada) })),
  find: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(notasPrevias) }),
  })),
});

const modeloSaldos = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

const modeloCarteraPorDocumento = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

const modeloAplicaciones = () => ({
  create: jest.fn((filas: Record<string, unknown>[]) =>
    Promise.resolve(filas.map((f, i) => ({ _id: `apl-${i}`, ...f }))),
  ),
});

const modeloAsientos = () => ({ create: jest.fn(() => Promise.resolve([{}])) });

// Every scenario in this file anchors its Nota Crédito on a Factura — these
// two models exist only so `NotasCreditoService`'s constructor is satisfied
// (`resolverLineasAncla`'s ND branch, the only caller of either, is never
// exercised here); ND-anchor coverage lives in its own dedicated tests below,
// which override these with real fixtures.
const modeloNotaDebitoVacio = () => ({});
const modeloConceptoCobroVacio = () => ({});

const modeloCopropiedades = () => ({
  findById: jest.fn(() => ({
    session: () => ({
      exec: () =>
        Promise.resolve({
          cuentaContableCartera: '130501',
          cuentaAnticipos: '210505',
          cuentaDevoluciones: '413595',
        }),
    }),
  })),
});

const construirServicio = (opts: {
  notaCreada: Record<string, unknown>;
  factura?: Record<string, unknown>;
  saldos?: { findOneAndUpdate: jest.Mock };
  copropiedades?: { findById: jest.Mock };
  cuentasContables?: Record<string, unknown>[];
  inmueble?: Record<string, unknown> | null;
  /** Same default as `lotesFacturacionFalso()`'s own: `null` means "never
   *  consolidated", so `crear()`'s period-match check on `dto.fecha` is a
   *  no-op — mirrors `recibos.service.spec.ts`'s identical override. */
  ultimoLoteConsolidado?: unknown;
  /** Other active Notas Crédito already issued against the anchor invoice —
   *  see `modeloNotasCredito`'s own comment. */
  notasCreditoPrevias?: Record<string, unknown>[];
  /** Real mocks for a Nota Débito-anchored scenario — omitted (the empty
   *  stand-ins above) for every FV-anchored test, which never reaches
   *  `resolverLineasAncla`'s ND branch. */
  notasDebito?: Record<string, unknown>;
  conceptosCobro?: Record<string, unknown>;
}) => {
  const session = sesionFalsa();
  const notasCredito = modeloNotasCredito(
    opts.notaCreada,
    opts.notasCreditoPrevias,
  );
  const factura = opts.factura ?? facturaDoc();
  const facturas = modeloFacturas(factura);
  const saldoTotalDocumento = modeloSaldoTotalDocumentoUnico(factura);
  const saldoDocumentoOrigen = modeloSaldoDocumentoOrigenUnico(opts.notaCreada);
  const saldos = opts.saldos ?? modeloSaldos();
  const carteraPorDocumento = modeloCarteraPorDocumento();
  const aplicaciones = modeloAplicaciones();
  const asientos = modeloAsientos();
  const copropiedades = opts.copropiedades ?? modeloCopropiedades();
  const cuentasContables = opts.cuentasContables && {
    find: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(opts.cuentasContables) }),
    })),
  };
  const inmuebles = opts.cuentasContables && {
    findById: jest.fn(() => ({
      session: () => ({
        exec: () => Promise.resolve(opts.inmueble ?? { codigo: '1304' }),
      }),
    })),
    // `resolverInmuebleCodigo`'s own lookup — no `.session()` chain, unlike
    // `findById` above (called outside any transaction).
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(opts.inmueble ?? { codigo: '1304' }),
    })),
  };

  const service = new NotasCreditoService(
    notasCredito as never,
    aplicaciones as never,
    facturas as never,
    saldos as never,
    carteraPorDocumento as never,
    saldoTotalDocumento as never,
    asientos as never,
    copropiedades as never,
    tenantQueDevuelve(COP),
    numeracionQueEntrega('NC-1'),
    conexionCon(session),
    lotesFacturacionFalso(opts.ultimoLoteConsolidado ?? null),
    saldoDocumentoOrigen as never,
    (opts.notasDebito ?? modeloNotaDebitoVacio()) as never,
    (opts.conceptosCobro ?? modeloConceptoCobroVacio()) as never,
    cuentasContables as never,
    inmuebles as never,
  );

  return {
    service,
    notasCredito,
    facturas,
    saldoTotalDocumento,
    saldoDocumentoOrigen,
    saldos,
    aplicaciones,
    asientos,
    copropiedades,
  };
};

/**
 * Full-field fixture for a persisted NotaCredito — mirrors
 * `recibos.service.spec.ts`'s own `reciboCreado()` fixture. Required by any
 * test that expects `crear()` to reach `toNotaCredito()` (the mapper needs
 * every schema field); tests that expect an exception BEFORE that point can
 * keep using a minimal `{}` or `{ _id, ... }` object, same precedent.
 */
const notaCreditoCreada = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  inmuebleId: INMUEBLE,
  terceroId: TERCERO,
  facturaId: new Types.ObjectId(),
  fecha: new Date('2026-01-15'),
  prefijo: 'NC',
  numero: 1,
  numeroCompleto: 'NC-1',
  motivo: 'error_facturacion',
  montoTotal: 200000,
  distribucion: [{ conceptoId: CONCEPTO, monto: 200000 }],
  montoAplicado: 0,
  montoSinAplicar: 200000,
  observaciones: null,
  estado: 'activo',
  motivoAnulacion: null,
  detalleAnulacion: null,
  fechaAnulacion: null,
  ...over,
});

const dtoBase = (over: Record<string, unknown> = {}) => ({
  codigo: 'NC',
  inmuebleId: INMUEBLE.toString(),
  tipoDocumento: 'FV' as const,
  documentoId: new Types.ObjectId().toString(),
  fecha: '2026-01-15',
  motivo: 'ajuste_precio' as const,
  montoTotal: 200000,
  distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 200000 }],
  ...over,
});

describe('NotasCreditoService.crear', () => {
  it('contra una factura con saldo suficiente, aplica en su totalidad y no deja anticipo', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, aplicaciones, saldoDocumentoOrigen } = construirServicio({
      notaCreada,
    });

    await service.crear('acc-1', dtoBase());

    expect(aplicaciones.create).toHaveBeenCalledTimes(1);
    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0]).toMatchObject({
      sourceType: 'NC',
      tipoDocumento: 'FV',
      montoAplicado: 200000,
    });
    // Persisted for printing (Nota Crédito's own PDF, styled after Recibo's
    // — needs the same per-concepto breakdown a Recibo application already
    // carries). Never reconstructable after the fact otherwise: this is the
    // only point `dto.distribucion` scaled against `montoAAplicar` exists.
    expect(filas[0].detalleConceptos).toEqual([
      { conceptoId: CONCEPTO, nombreConcepto: 'Concepto', monto: 200000 },
    ]);
    // La NotaCredito ya no cachea `montoAplicado`/`montoSinAplicar` — el
    // decremento vivo ahora es el `$expr`-guarded `findOneAndUpdate` contra
    // `SaldoDocumentoOrigen` (ver `decrementarSaldoDocumentoOrigen`).
    expect(saldoDocumentoOrigen.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        documentoId: notaCreada._id,
        $expr: { $gte: ['$saldoDisponible', 200000] },
      }),
      { $inc: { saldoDisponible: -200000 } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });

  it('agrega tercero/centroCosto/flujoCaja cuando cuentasContables está disponible', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({
      notaCreada,
      copropiedades: {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                cuentaContableCartera: '130501',
                cuentaAnticipos: '210505',
                cuentaDevoluciones: '413595',
                centroCostoDefecto: 'CC-01',
                flujoCajaCodigo: 'FC-OPER',
              }),
          }),
        })),
      },
      cuentasContables: [
        {
          codigo: '413595',
          requiereTercero: true,
          centroUtilidad: true,
          centroDestino: false,
          flujoCaja: false,
        },
      ],
      inmueble: { codigo: '1304' },
    });

    await service.crear('acc-1', dtoBase());

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].movimientos as Array<{
      cuenta: string;
      tercero?: string | null;
      centroCosto?: string | null;
    }>;
    const devoluciones = entries.find((e) => e.cuenta === '413595');
    expect(devoluciones?.tercero).toBe('1304');
    expect(devoluciones?.centroCosto).toBe('CC-01');
  });

  it('NO mueve cuentasOrden cuando la nota nunca toca un concepto de intereses', async () => {
    // Regresión: `construirAsientoCruce` mueve `cuentasOrden` por el monto
    // completo cuando `montoCuentasOrden` se omite — antes del fix, esta
    // llamada siempre lo omitía, moviendo el par memo aunque la nota
    // corrigiera solo Administración.
    const factura = facturaDoc({
      lineas: [
        {
          conceptoId: CONCEPTO,
          tipoConcepto: 'administracion',
          valorTotal: 200000,
        },
      ],
    });
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({
      notaCreada,
      factura,
      copropiedades: {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                cuentaContableCartera: '130501',
                cuentaAnticipos: '210505',
                cuentaDevoluciones: '413595',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
          }),
        })),
      },
    });

    await service.crear('acc-1', dtoBase());

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].movimientos as Array<{ cuenta: string }>;
    expect(entries.some((e) => e.cuenta === '831505')).toBe(false);
    expect(entries.some((e) => e.cuenta === '831510')).toBe(false);
  });

  it('mueve cuentasOrden SOLO por la porción de la nota aplicada contra un concepto de intereses', async () => {
    const conceptoMora = new Types.ObjectId();
    const factura = facturaDoc({
      saldoPendiente: 200000,
      total: 200000,
      lineas: [
        {
          conceptoId: CONCEPTO,
          tipoConcepto: 'administracion',
          valorTotal: 150000,
        },
        {
          conceptoId: conceptoMora,
          tipoConcepto: 'intereses',
          valorTotal: 50000,
        },
      ],
    });
    const notaCreada = notaCreditoCreada({ montoTotal: 200000 });
    const { service, asientos } = construirServicio({
      notaCreada,
      factura,
      copropiedades: {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                cuentaContableCartera: '130501',
                cuentaAnticipos: '210505',
                cuentaDevoluciones: '413595',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
          }),
        })),
      },
    });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 200000,
        distribucion: [
          { conceptoId: CONCEPTO.toString(), monto: 150000 },
          { conceptoId: conceptoMora.toString(), monto: 50000 },
        ],
      }),
    );

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].movimientos as Array<{
      cuenta: string;
      monto: number;
    }>;
    // El par memo debe moverse por 50000 (solo mora) — nunca por los 200000
    // totales de la nota.
    expect(
      entries.find((e) => e.cuenta === '831505' || e.cuenta === '831510')
        ?.monto,
    ).toBe(50000);
  });

  it('no debita/acredita las cuentas reales de un concepto de intereses cuando la aplicación es completa — solo cuentasOrden', async () => {
    const conceptoMora = new Types.ObjectId();
    const factura = facturaDoc({
      saldoPendiente: 200000,
      total: 200000,
      lineas: [
        {
          conceptoId: CONCEPTO,
          tipoConcepto: 'administracion',
          valorTotal: 150000,
          cuentaIngreso: '413501',
          cuentaCartera: '130599',
        },
        {
          conceptoId: conceptoMora,
          tipoConcepto: 'intereses',
          valorTotal: 50000,
          cuentaIngreso: '413502',
          cuentaCartera: '130502',
        },
      ],
    });
    const notaCreada = notaCreditoCreada({ montoTotal: 200000 });
    const { service, asientos } = construirServicio({
      notaCreada,
      factura,
      copropiedades: {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                cuentaContableCartera: '130501',
                cuentaAnticipos: '210505',
                cuentaDevoluciones: '413595',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
          }),
        })),
      },
    });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 200000,
        distribucion: [
          { conceptoId: CONCEPTO.toString(), monto: 150000 },
          { conceptoId: conceptoMora.toString(), monto: 50000 },
        ],
      }),
    );

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].movimientos as Array<{
      cuenta: string;
      monto: number;
    }>;

    // La cuenta real de intereses (CxC/Ingreso) nunca debe aparecer — su
    // reverso va SOLO por cuentasOrden, igual que su cargo original nunca
    // las tocó (construirMovimientos).
    expect(entries.some((e) => e.cuenta === '413502')).toBe(false);
    expect(entries.some((e) => e.cuenta === '130502')).toBe(false);

    // Administración sí se mueve normalmente por sus propias cuentas.
    expect(entries.find((e) => e.cuenta === '413501')?.monto).toBe(150000);
    expect(entries.find((e) => e.cuenta === '130599')?.monto).toBe(150000);

    // cuentasOrden se mueve por los 50000 de mora, sin cambios.
    expect(
      entries.find((e) => e.cuenta === '831505' || e.cuenta === '831510')
        ?.monto,
    ).toBe(50000);
  });

  it('acredita la cuenta propia del concepto cuando la línea de la factura ancla la trae configurada', async () => {
    const factura = facturaDoc({
      numero: 42,
      lineas: [
        {
          conceptoId: CONCEPTO,
          valorTotal: 200000,
          cuentaCartera: '130599',
        },
      ],
    });
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({ notaCreada, factura });

    await service.crear('acc-1', dtoBase());

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].movimientos as Array<{
      cuenta: string;
      tipo: string;
      monto: number;
      tipoDocumento: string | null;
      numeroDocumento: number | null;
    }>;
    const creditos = entries.filter((m) => m.tipo === 'credito');
    // La cuenta propia del concepto (130599), NO la cuenta plana de cartera
    // de la copropiedad (130501) — aplicación total, sin anticipo. El
    // documento cruce (FV-42, la factura ancla) viaja con la línea, igual
    // que en `aplicarManual`/`aplicarFifo`.
    expect(creditos).toEqual([
      {
        cuenta: '130599',
        tipo: 'credito',
        monto: 200000,
        descripcion: expect.any(String) as string,
        tipoDocumento: 'FV',
        numeroDocumento: 42,
      },
    ]);
  });

  it('cuando montoTotal excede el saldo de la factura ancla, aplica lo que cabe y el resto queda como anticipo', async () => {
    const factura = facturaDoc({
      saldoPendiente: 120000,
      total: 300000,
      lineas: [{ conceptoId: CONCEPTO, valorTotal: 300000 }],
    });
    const notaCreada = notaCreditoCreada({
      montoTotal: 300000,
      montoSinAplicar: 300000,
      distribucion: [{ conceptoId: CONCEPTO, monto: 300000 }],
    });
    const { service, aplicaciones } = construirServicio({
      notaCreada,
      factura,
    });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 300000,
        distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 300000 }],
      }),
    );

    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0].montoAplicado).toBe(120000);
  });

  it('no aplica nada, y no crea AplicacionCartera, cuando la factura ancla ya tiene saldo cero', async () => {
    const factura = facturaDoc({ saldoPendiente: 0 });
    const notaCreada = notaCreditoCreada();
    const { service, aplicaciones } = construirServicio({
      notaCreada,
      factura,
    });

    await service.crear('acc-1', dtoBase());

    expect(aplicaciones.create).not.toHaveBeenCalled();
  });

  it('rechaza cuando la distribución no suma exacto al monto total, sin llegar a numerar', async () => {
    const numeracion = numeracionQueEntrega('NC-1');
    const { facturas } = construirServicio({ notaCreada: {} });
    // A fresh instance wired with a spied NumeracionService, so this test can
    // assert numbering never runs when distribution validation fails first.
    const servicioEspiado = new NotasCreditoService(
      modeloNotasCredito({}) as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracion,
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await expect(
      servicioEspiado.crear(
        'acc-1',
        dtoBase({
          distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 100000 }],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      (numeracion as unknown as { siguienteDocumento: jest.Mock })
        .siguienteDocumento,
    ).not.toHaveBeenCalled();
  });

  it('rechaza cuando dto.inmuebleId no coincide con factura.inmuebleId — no debe permitir emparejar una unidad con la factura de otra', async () => {
    const otroInmueble = new Types.ObjectId();
    const factura = facturaDoc({ inmuebleId: otroInmueble });
    const { service } = construirServicio({ notaCreada: {}, factura });

    await expect(
      service.crear('acc-1', dtoBase({ inmuebleId: INMUEBLE.toString() })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando, sumada a otras notas crédito activas ya emitidas contra la misma factura, el concepto se pasaría de su propio valor de emisión', async () => {
    // La factura ancla cobra 200000 por CONCEPTO. Una nota crédito previa
    // (todavía activa) ya le acreditó 150000 — a esta nueva, aunque 100000
    // por sí solo no supera el tope DE LA FACTURA (200000), no le quedan
    // más de 50000 disponibles.
    const notaPrevia = {
      facturaId: new Types.ObjectId(),
      estado: 'activo',
      distribucion: [{ conceptoId: CONCEPTO, monto: 150000 }],
    };
    const { service, notasCredito } = construirServicio({
      notaCreada: {},
      notasCreditoPrevias: [notaPrevia],
    });

    await expect(
      service.crear(
        'acc-1',
        dtoBase({
          montoTotal: 100000,
          distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 100000 }],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Solo cuenta lo emitido bajo la MISMA factura ancla, y solo mientras
    // sigue activo — una nota anulada ya reversó su crédito.
    expect(notasCredito.find).toHaveBeenCalledWith(
      expect.objectContaining({ estado: 'activo' }),
    );
  });

  it('acepta cuando lo ya acreditado por otras notas crédito activas más esta nueva cabe exacto en el valor de emisión del concepto', async () => {
    const notaPrevia = {
      facturaId: new Types.ObjectId(),
      estado: 'activo',
      distribucion: [{ conceptoId: CONCEPTO, monto: 150000 }],
    };
    const notaCreada = notaCreditoCreada({ montoTotal: 50000 });
    const { service } = construirServicio({
      notaCreada,
      notasCreditoPrevias: [notaPrevia],
    });

    await expect(
      service.crear(
        'acc-1',
        dtoBase({
          montoTotal: 50000,
          distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 50000 }],
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rechaza una nota crédito contra una factura ya anulada', async () => {
    const factura = facturaDoc({ estado: 'anulada' });
    const { service } = construirServicio({ notaCreada: {}, factura });

    await expect(service.crear('acc-1', dtoBase())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rechaza cuando la factura ancla no existe bajo este tenant', async () => {
    const { service, facturas } = construirServicio({ notaCreada: {} });
    facturas.findOne = jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(null) }),
    })) as never;

    await expect(service.crear('acc-1', dtoBase())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('descuenta SaldoCartera según la distribución elegida por el usuario, NO el split proporcional de las líneas de la factura ancla', async () => {
    const conceptoP = new Types.ObjectId();
    const conceptoQ = new Types.ObjectId();
    // Las líneas de la factura son 50%/50% (300000/300000 sobre un total de
    // 600000) — si el reparto fuera proporcional al aplicar 400000, tocaría
    // 200000/200000. La distribución elegida por el usuario es 250000/150000
    // (dentro del tope de cada concepto, validarDistribucionNotaCredito lo
    // permite). Si `crear()` usara `ajustarSaldosCartera` (proporcional) en
    // lugar de `ajustarSaldosCarteraPorDistribucion`, este test detectaría
    // la regresión.
    const factura = facturaDoc({
      saldoPendiente: 400000,
      total: 600000,
      lineas: [
        { conceptoId: conceptoP, valorTotal: 300000 },
        { conceptoId: conceptoQ, valorTotal: 300000 },
      ],
    });
    const notaCreada = notaCreditoCreada({
      montoTotal: 400000,
      // El saldo VIVO pre-aplicación (`SaldoDocumentoOrigen`, reusa este
      // mismo campo de fixture) tiene que arrancar en el monto total: esta
      // es la auto-aplicación de `crear()` contra la factura ancla, no un
      // estado final ya aplicado.
      montoSinAplicar: 400000,
      distribucion: [
        { conceptoId: conceptoP, monto: 250000 },
        { conceptoId: conceptoQ, monto: 150000 },
      ],
    });
    const llamadasSaldos: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadasSaldos.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const { service } = construirServicio({ notaCreada, factura, saldos });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 400000,
        distribucion: [
          { conceptoId: conceptoP.toString(), monto: 250000 },
          { conceptoId: conceptoQ.toString(), monto: 150000 },
        ],
      }),
    );

    expect(llamadasSaldos).toHaveLength(2);
    const extraerMonto = (conceptoId: Types.ObjectId) => {
      const llamada = llamadasSaldos.find(([f]) =>
        (f.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      const pipeline = llamada![1] as [
        {
          $set: {
            saldoPendiente: { $max: [number, { $add: [string, number] }] };
          };
        },
      ];
      return pipeline[0].$set.saldoPendiente.$max[1].$add[1];
    };

    expect(extraerMonto(conceptoP)).toBe(-250000);
    expect(extraerMonto(conceptoQ)).toBe(-150000);
  });

  it('postea el asiento de creación debitando cuentaDevoluciones', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({ notaCreada });

    await service.crear('acc-1', dtoBase());

    const [[creado]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const [entrada] = creado as [
      { notaCreditoId: unknown; movimientos: Record<string, unknown>[] },
    ];
    expect(entrada.notaCreditoId).toEqual(notaCreada._id);
    expect(entrada.movimientos[0]).toMatchObject({
      cuenta: '413595',
      tipo: 'debito',
    });
  });

  it('fecha el asiento de creación con la fecha PROPIA de la nota (issueDate), nunca new Date() — o desaparece de Consulta de Movimientos al filtrar por su período real', async () => {
    // Bug real reportado: una nota creada "hoy" con una fecha declarada de
    // otro día del mismo período de facturación quedaba con el asiento
    // fechado "hoy" (el instante del servidor) en vez de la fecha que el
    // usuario eligió — Consulta de Movimientos filtra por AsientoContable.fecha,
    // así que la nota no aparecía al buscar por su propio período.
    const notaCreada = notaCreditoCreada({ fecha: new Date('2026-01-05') });
    const { service, asientos } = construirServicio({ notaCreada });

    await service.crear('acc-1', dtoBase({ fecha: '2026-01-05' }));

    const [[creado]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const [entrada] = creado as unknown as [{ fecha: Date }];
    expect(entrada.fecha).toEqual(new Date('2026-01-05'));
  });

  it('debita la cuenta de ingreso PROPIA de cada concepto (cuentaIngreso de la factura ancla) — nunca una sola cuentaDevoluciones para todo', async () => {
    // Reportado en producción: el PDF salía con "Sin cuenta asignada" en el
    // débito porque copropiedad.cuentaDevoluciones no estaba configurada —
    // pero además, aun configurada, una sola cuenta para TODA la nota es
    // incorrecto: debe reversar el ingreso de cada concepto en la MISMA
    // cuenta que se acreditó al facturarlo (ConceptoCobro.cuentaCreditoId,
    // congelada como FacturaLinea.cuentaIngreso).
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const factura = facturaDoc({
      saldoPendiente: 130000,
      total: 130000,
      lineas: [
        {
          conceptoId: conceptoAdmin,
          valorTotal: 100000,
          cuentaIngreso: '413501',
        },
        {
          conceptoId: conceptoMora,
          valorTotal: 30000,
          cuentaIngreso: '413502',
        },
      ],
    });
    const { service, asientos } = construirServicio({
      notaCreada: notaCreditoCreada({ montoTotal: 130000 }),
      factura,
    });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 130000,
        distribucion: [
          { conceptoId: conceptoAdmin.toString(), monto: 100000 },
          { conceptoId: conceptoMora.toString(), monto: 30000 },
        ],
      }),
    );

    const [[creado]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const [entrada] = creado as unknown as [
      { movimientos: Record<string, unknown>[] },
    ];
    const debitos = entrada.movimientos.filter((e) => e.tipo === 'debito');
    expect(debitos).toEqual([
      expect.objectContaining({ cuenta: '413501', monto: 100000 }),
      expect.objectContaining({ cuenta: '413502', monto: 30000 }),
    ]);
  });
});

describe('NotasCreditoService.crear — ancla Nota Débito', () => {
  const notaDebitoDoc = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    copropiedadId: COP,
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    conceptoId: CONCEPTO,
    estado: 'emitida',
    numeroCompleto: 'ND-1',
    numero: 1,
    total: 150000,
    saldoPendiente: 150000,
    descripcion: 'Multa por parqueo',
    ...over,
  });

  const modeloNotaDebito = (nota: Record<string, unknown>) => ({
    findOne: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(nota) }),
    })),
  });

  const modeloConceptoCobro = (concepto: Record<string, unknown> | null) => ({
    findOne: jest.fn(() => ({
      populate: () => ({
        populate: () => ({
          session: () => ({ exec: () => Promise.resolve(concepto) }),
        }),
      }),
    })),
  });

  const dtoNotaDebito = (
    notaDebito: { _id: Types.ObjectId },
    over: Record<string, unknown> = {},
  ) => ({
    codigo: 'NC',
    inmuebleId: INMUEBLE.toString(),
    tipoDocumento: 'ND' as const,
    documentoId: notaDebito._id.toString(),
    fecha: '2026-01-15',
    motivo: 'devolucion_parcial' as const,
    montoTotal: 150000,
    distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 150000 }],
    ...over,
  });

  it('crea la nota contra una Nota Débito, decrementando su saldo y guardando notaDebitoId (nunca facturaId)', async () => {
    const notaDebito = notaDebitoDoc();
    const notaCreada = notaCreditoCreada({
      facturaId: null,
      notaDebitoId: notaDebito._id,
      tipoDocumentoAncla: 'ND',
      montoTotal: 150000,
      distribucion: [{ conceptoId: CONCEPTO, monto: 150000 }],
    });
    const notasCredito = modeloNotasCredito(notaCreada);
    const saldoTotalDocumento = modeloSaldoTotalDocumentoUnico(notaDebito);
    const saldoDocumentoOrigen = modeloSaldoDocumentoOrigenUnico(notaCreada);
    const concepto = {
      _id: CONCEPTO,
      nombre: 'Multa por parqueo',
      tipo: 'otro',
      cuentaCreditoId: { codigo: '413595' },
      cuentaDebitoId: { codigo: '130505' },
    };

    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      saldoDocumentoOrigen as never,
      modeloNotaDebito(notaDebito) as never,
      modeloConceptoCobro(concepto) as never,
    );

    await service.crear('acc-1', dtoNotaDebito(notaDebito));

    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ documentoId: notaDebito._id }),
      { $inc: { saldoPendiente: -150000 } },
      expect.anything(),
    );
    const [[filas]] = notasCredito.create.mock.calls as unknown as [
      Record<string, unknown>[],
    ][];
    expect(filas[0]).toMatchObject({
      facturaId: null,
      notaDebitoId: notaDebito._id,
      tipoDocumentoAncla: 'ND',
    });
  });

  it('cuando el ancla ND no trae terceroId (congelado null desde antes del propio fix de Notas Débito), cae al titularId ACTUAL del inmueble en vez de dejarlo en blanco', async () => {
    const TITULAR = new Types.ObjectId();
    const notaDebito = notaDebitoDoc({ terceroId: null });
    const notaCreada = notaCreditoCreada({
      facturaId: null,
      notaDebitoId: notaDebito._id,
      tipoDocumentoAncla: 'ND',
      montoTotal: 150000,
      distribucion: [{ conceptoId: CONCEPTO, monto: 150000 }],
    });
    const notasCredito = modeloNotasCredito(notaCreada);
    const concepto = {
      _id: CONCEPTO,
      nombre: 'Multa por parqueo',
      tipo: 'otro',
      cuentaCreditoId: { codigo: '413595' },
      cuentaDebitoId: { codigo: '130505' },
    };
    const inmuebles = {
      findOne: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve({ _id: INMUEBLE, titularId: TITULAR }),
        }),
        // `resolverInmuebleCodigo`'s own lookup — no `.session()` chain,
        // unlike the terceroId resolution above (called inside a
        // transaction).
        exec: () =>
          Promise.resolve({
            _id: INMUEBLE,
            titularId: TITULAR,
            codigo: '1304',
          }),
      })),
    };

    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumentoUnico(notaDebito) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigenUnico(notaCreada) as never,
      modeloNotaDebito(notaDebito) as never,
      modeloConceptoCobro(concepto) as never,
      undefined,
      inmuebles as never,
    );

    await service.crear('acc-1', dtoNotaDebito(notaDebito));

    const [[filas]] = notasCredito.create.mock.calls as unknown as [
      Record<string, unknown>[],
    ][];
    expect(filas[0].terceroId).toBe(TITULAR);
  });

  it('rechaza el motivo "anulacion_factura" contra una Nota Débito — ese motivo es exclusivo de Factura', async () => {
    const notaDebito = notaDebitoDoc();
    const service = new NotasCreditoService(
      modeloNotasCredito({}) as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumentoUnico(notaDebito) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebito(notaDebito) as never,
      modeloConceptoCobro(null) as never,
    );

    await expect(
      service.crear(
        'acc-1',
        dtoNotaDebito(notaDebito, { motivo: 'anulacion_factura' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('NotasCreditoService.crear — fecha de la nota', () => {
  it('guarda dto.fecha como issueDate del documento creado', async () => {
    const { service, notasCredito } = construirServicio({
      notaCreada: notaCreditoCreada(),
    });

    await service.crear('acc-1', dtoBase({ fecha: '2026-01-20' }));

    const [filas] = notasCredito.create.mock.calls[0] as unknown as [
      Record<string, unknown>[],
    ];
    expect(filas[0]).toMatchObject({ fecha: new Date('2026-01-20') });
  });

  it('rechaza una fecha de un mes distinto al del último lote consolidado', async () => {
    const { service, notasCredito, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: {
        periodoDesde: new Date('2026-08-01'),
        periodoHasta: new Date('2026-08-31'),
      },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-07-15' })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(notasCredito.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });

  it('deja pasar una fecha del mismo mes y año del último lote consolidado', async () => {
    const { service, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: {
        periodoDesde: new Date('2026-08-01'),
        periodoHasta: new Date('2026-08-31'),
      },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-08-27' })),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });

  it('no valida nada cuando la copropiedad nunca ha consolidado un lote', async () => {
    const { service } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: null,
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2020-01-01' })),
    ).resolves.toBeDefined();
  });

  it('un lote facturado el día 1 del mes no corre el período un mes hacia atrás (mismo bug real de Recibos)', async () => {
    // Ver el test gemelo en recibos.service.spec.ts.
    const { service, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: {
        periodoDesde: new Date('2026-08-01'),
        periodoHasta: new Date('2026-08-31'),
      },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-08-31' })),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });

  it('rechaza una fecha del mismo mes calendario pero fuera del rango real del período (periodoHasta, no fin de mes)', async () => {
    // El período de un lote no siempre coincide con el mes calendario
    // entero — esta validación compara contra el rango real
    // (`periodoDesde`/`periodoHasta`), no contra "mismo mes/año", así que una
    // nota posterior a `periodoHasta` se rechaza aunque siga siendo el mismo mes.
    const { service, notasCredito, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: {
        periodoDesde: new Date('2026-08-01'),
        periodoHasta: new Date('2026-08-15'),
      },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-08-20' })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(notasCredito.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });
});

const notaActivaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  // `facturaId`/`distribution` were missing from the brief's own fixture —
  // harmless for the pre-existing `aplicar()` tests below (they never touch
  // `toNotaCredito`), but `anular()` (Task 8) always maps its final document
  // through `toNotaCredito`, which does `doc.facturaId.toString()` and
  // `doc.distribution.map(...)` unconditionally. Without these two fields
  // that throws a TypeError instead of returning the mapped contract. Added
  // additively — no existing assertion touches either field.
  facturaId: new Types.ObjectId(),
  distribucion: [],
  numeroCompleto: 'NC-1',
  montoTotal: 200000,
  montoAplicado: 120000,
  montoSinAplicar: 80000,
  estado: 'activo',
  // NotaCredito has no declared business date field of its own —
  // `createdAt` is its issue date, read by `toAplicacionCartera` via a cast
  // (see `notas-credito.service.ts`'s own `fechaNota`).
  createdAt: new Date('2026-08-15'),
  ...over,
});

describe('NotasCreditoService.aplicar', () => {
  it('aplica manualmente contra otra factura del mismo inmueble y descuenta montoSinAplicar', async () => {
    const nota = notaActivaDoc();
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $inc?: Record<string, number> }) => ({
          exec: () => {
            if (update?.$inc) {
              nota.montoAplicado += update.$inc.montoAplicado ?? 0;
              nota.montoSinAplicar += update.$inc.montoSinAplicar ?? 0;
            }
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const otraFactura = facturaDoc({
      saldoPendiente: 80000,
      inmuebleId: INMUEBLE,
    });
    const facturas = modeloFacturas(otraFactura);
    const aplicaciones = modeloAplicaciones();
    const saldoTotalDocumento = modeloSaldoTotalDocumento([otraFactura]);
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([nota]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    const resultado = await service.aplicar(
      nota._id.toString(),
      {
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: otraFactura._id.toString(),
            montoAplicado: 80000,
          },
        ],
      },
      'acc-1',
    );

    expect(resultado.aplicadas).toHaveLength(1);
    expect(resultado.errores).toEqual([]);
    expect(aplicaciones.create).toHaveBeenCalledTimes(1);
    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0]).toMatchObject({ sourceType: 'NC', sourceId: nota._id });
    // Same reasoning as `crear()`'s own assertion: needed for the PDF's
    // débito/crédito table, and only reconstructable right here — this is a
    // DEFERRED application (`aplicarManual`), so it must capture
    // `ajustarSaldosCartera`'s own return, not `dto.distribucion`.
    expect(filas[0].detalleConceptos).toEqual([
      { conceptoId: CONCEPTO, nombreConcepto: 'Concepto', monto: 80000 },
    ]);
  });

  it('al aplicar contra OTRA factura, sigue usando el split proporcional de esa factura (ajustarSaldosCartera, sin cambios) — nunca la distribución original de la NC', async () => {
    // `distribution` de la nota es deliberadamente irrelevante para esta
    // aplicación — pertenece únicamente a la factura ancla de `crear()`
    // (design §5/§6). Si `aplicar()` empezara a usar
    // `ajustarSaldosCarteraPorDistribucion` por error, este test lo
    // detectaría: el monto no calzaría con el split 75/25 de la OTRA
    // factura.
    const nota = notaActivaDoc({
      distribucion: [{ conceptoId: CONCEPTO, monto: 999999 }],
    });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $inc?: Record<string, number> }) => ({
          exec: () => {
            if (update?.$inc) {
              nota.montoAplicado += update.$inc.montoAplicado ?? 0;
              nota.montoSinAplicar += update.$inc.montoSinAplicar ?? 0;
            }
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const conceptoR = new Types.ObjectId();
    const conceptoS = new Types.ObjectId();
    const otraFactura = facturaDoc({
      saldoPendiente: 80000,
      inmuebleId: INMUEBLE,
      total: 80000,
      lineas: [
        { conceptoId: conceptoR, valorTotal: 60000 },
        { conceptoId: conceptoS, valorTotal: 20000 },
      ],
    });
    const facturas = modeloFacturas(otraFactura);
    const aplicaciones = modeloAplicaciones();
    const llamadasSaldos: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadasSaldos.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([otraFactura]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([nota]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.aplicar(
      nota._id.toString(),
      {
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: otraFactura._id.toString(),
            montoAplicado: 80000,
          },
        ],
      },
      'acc-1',
    );

    expect(llamadasSaldos).toHaveLength(2);
    const extraerMonto = (conceptoId: Types.ObjectId) => {
      const llamada = llamadasSaldos.find(([f]) =>
        (f.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      const pipeline = llamada![1] as [
        {
          $set: {
            saldoPendiente: { $max: [number, { $add: [string, number] }] };
          };
        },
      ];
      return pipeline[0].$set.saldoPendiente.$max[1].$add[1];
    };

    // 75%/25% de 80000 según las líneas de la OTRA factura.
    expect(extraerMonto(conceptoR)).toBe(-60000);
    expect(extraerMonto(conceptoS)).toBe(-20000);
  });

  it('rechaza aplicar manual y automático a la vez', async () => {
    const { service } = construirServicio({ notaCreada: notaActivaDoc() });

    // NOTE: the brief's own fixture used `aplicaciones: []` here, but an
    // empty array has `.length === 0` — falsy — so the guard
    // `dto.aplicaciones?.length && dto.aplicacionAutomatica` (mirrored
    // verbatim from `RecibosService.aplicar()`) never fires, and the
    // request silently falls through to the FIFO branch instead of being
    // rejected, throwing a TypeError from an unmocked `facturas.find()`
    // rather than the intended BadRequestException. Fixed by giving
    // `aplicaciones` an actual entry, matching the test's own intent (a
    // manual request combined with `aplicacionAutomatica: true`). The
    // assertion itself is untouched.
    await expect(
      service.aplicar(
        'nc-1',
        {
          aplicaciones: [
            {
              tipoDocumento: 'FV',
              documentoId: new Types.ObjectId().toString(),
              montoAplicado: 1000,
            },
          ],
          aplicacionAutomatica: true,
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza cuando no se pide ni manual ni automático', async () => {
    const { service } = construirServicio({ notaCreada: notaActivaDoc() });

    await expect(service.aplicar('nc-1', {}, 'acc-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rechaza aplicar sobre una nota crédito anulada', async () => {
    const nota = notaActivaDoc({ estado: 'anulado' });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await expect(
      service.aplicar(
        nota._id.toString(),
        { aplicacionAutomatica: true },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando la nota crédito no existe bajo este tenant', async () => {
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await expect(
      service.aplicar('nc-ajena', { aplicacionAutomatica: true }, 'acc-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NotasCreditoService.anular', () => {
  it('revierte cada AplicacionCartera activa (sourceType NC) y restaura el saldoPendiente de cada factura afectada', async () => {
    const facturaId = new Types.ObjectId();
    const nota = notaActivaDoc({
      montoAplicado: 120000,
      montoSinAplicar: 80000,
      montoTotal: 200000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentoId: facturaId,
      tipoDocumento: 'FV',
      montoAplicado: 120000,
      estado: 'activa',
    };
    const facturaFrozen = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 200000,
      lineas: [],
    };
    const facturas = {
      // Resolves `desgloseOrigen`'s per-concepto débito accounts (looked up
      // by `nota.facturaId`, a DIFFERENT id here) — `null` there just means
      // the reversal falls back to `cuentaDevoluciones`, which this test
      // doesn't assert on. The reversal loop's own lookup, by
      // `aplicacion.documentoId` (== `facturaId`), DOES need a real document.
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              String(filtro._id) === String(facturaId)
                ? { ...facturaFrozen }
                : null,
            ),
        }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, saldoPendiente: 80000 },
    ]);
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    const resultado = await service.anular(
      nota._id.toString(),
      {
        motivo: 'error_facturacion',
        detalle: 'Nota crédito emitida por error, se anula',
        fecha: '2026-01-20',
      },
      'acc-1',
    );

    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalledWith(
      { documentoId: facturaId },
      { $inc: { saldoPendiente: 120000 } },
      { returnDocument: 'after', session: expect.anything() as unknown },
    );
    expect(resultado.estado).toBe('anulado');
    expect(resultado.montoAplicado).toBe(0);
    expect(resultado.montoSinAplicar).toBe(0);
  });

  it('reversa el débito por la cuenta de ingreso PROPIA de cada concepto (nota.distribution + cuentaIngreso de la factura ancla) — nunca cuentaDevoluciones sola', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const nota = notaActivaDoc({
      facturaId,
      distribucion: [
        { conceptoId: conceptoAdmin, monto: 100000 },
        { conceptoId: conceptoMora, monto: 30000 },
      ],
      montoAplicado: 130000,
      montoSinAplicar: 0,
      montoTotal: 130000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentoId: facturaId,
      tipoDocumento: 'FV',
      montoAplicado: 130000,
      estado: 'activa',
    };
    const facturaAncla = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 130000,
      lineas: [
        {
          conceptoId: conceptoAdmin,
          valorTotal: 100000,
          cuentaIngreso: '413501',
        },
        {
          conceptoId: conceptoMora,
          valorTotal: 30000,
          cuentaIngreso: '413502',
        },
      ],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve({ ...facturaAncla } as never),
        }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, saldoPendiente: 0 },
    ]);
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.anular(
      nota._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Anula la nota crédito por error de digitación',
        fecha: '2026-01-20',
      },
      'acc-1',
    );

    const [[creado]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const [entrada] = creado as unknown as [
      { movimientos: Record<string, unknown>[] },
    ];
    const creditos = entrada.movimientos.filter((e) => e.tipo === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ cuenta: '413501', monto: 100000 }),
      expect.objectContaining({ cuenta: '413502', monto: 30000 }),
    ]);
  });

  it('al anular, revierte cuentasOrden SOLO por la porción que era intereses, nunca por el total reversado', async () => {
    // Regresión: `construirContraAsientoCruce` también omitía
    // `montoCuentasOrden`, por lo que anular una nota que corrigió mora Y
    // administración revertía el par memo por el monto COMPLETO en lugar de
    // solo la porción de mora.
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const nota = notaActivaDoc({
      facturaId,
      distribucion: [
        { conceptoId: conceptoAdmin, monto: 100000 },
        { conceptoId: conceptoMora, monto: 30000 },
      ],
      montoAplicado: 130000,
      montoSinAplicar: 0,
      montoTotal: 130000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentoId: facturaId,
      tipoDocumento: 'FV',
      montoAplicado: 130000,
      estado: 'activa',
      detalleConceptos: [
        {
          conceptoId: conceptoAdmin,
          nombreConcepto: 'Administración',
          monto: 100000,
        },
        {
          conceptoId: conceptoMora,
          nombreConcepto: 'Intereses por mora',
          monto: 30000,
        },
      ],
    };
    const facturaAncla = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 130000,
      lineas: [
        {
          conceptoId: conceptoAdmin,
          tipoConcepto: 'administracion',
          valorTotal: 100000,
          cuentaIngreso: '413501',
        },
        {
          conceptoId: conceptoMora,
          tipoConcepto: 'intereses',
          valorTotal: 30000,
          cuentaIngreso: '413502',
        },
      ],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve({ ...facturaAncla } as never),
        }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, saldoPendiente: 0 },
    ]);
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                cuentaContableCartera: '130501',
                cuentaAnticipos: '210505',
                cuentaDevoluciones: '413595',
                usaCuentasOrden: true,
                cuentaOrdenDebito: '831505',
                cuentaOrdenCredito: '831510',
              }),
          }),
        })),
      } as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.anular(
      nota._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Anula la nota crédito por error de digitación',
        fecha: '2026-01-20',
      },
      'acc-1',
    );

    const [[creado]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const [entrada] = creado as unknown as [
      { movimientos: { cuenta: string; monto: number }[] },
    ];
    const memo = entrada.movimientos.find(
      (e) => e.cuenta === '831505' || e.cuenta === '831510',
    );
    expect(memo?.monto).toBe(30000);
  });

  // Mirrors `recibos.service.spec.ts`'s
  // 'restaura el saldo aunque la factura afectada ya esté anulada por otra
  // vía' — added per code-review finding on this task (test-coverage gap
  // only; `anular()`'s `if (factura)` guard already handles this correctly).
  it('revierte la aplicación aunque la factura afectada ya esté anulada por otra vía (no rompe, es contabilidad inofensiva)', async () => {
    const facturaId = new Types.ObjectId();
    const nota = notaActivaDoc({
      montoAplicado: 120000,
      montoSinAplicar: 80000,
      montoTotal: 200000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentoId: facturaId,
      tipoDocumento: 'FV',
      montoAplicado: 120000,
      estado: 'activa',
    };

    // La factura ya no existe bajo esas condiciones (anulada por otra vía) —
    // el findOne devuelve null, y el cascade sigue sin lanzar.
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
    };
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await expect(
      service.anular(
        nota._id.toString(),
        {
          motivo: 'otro',
          detalle: 'La factura ya fue anulada por otra vía',
          fecha: '2026-01-20',
        },
        'acc-1',
      ),
    ).resolves.toBeDefined();

    // La AplicacionCartera se marca revertida de todos modos — la reversión
    // del cruce es incondicional (design §6).
    expect(aplicaciones.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('con una aplicación ANCLA (de crear()) y una NO ancla (de un aplicar() previo contra otra factura), reversa cada una con la matemática que la originó — nunca al revés', async () => {
    const facturaAncla = new Types.ObjectId();
    const facturaOtra = new Types.ObjectId();
    const conceptoX = new Types.ObjectId();
    const conceptoY = new Types.ObjectId();
    const conceptoZ = new Types.ObjectId();

    const nota = notaActivaDoc({
      facturaId: facturaAncla,
      distribucion: [
        { conceptoId: conceptoX, monto: 150000 },
        { conceptoId: conceptoY, monto: 50000 },
      ],
      montoAplicado: 280000,
      montoSinAplicar: 0,
      montoTotal: 280000,
    });

    // La ancla: creada en crear() contra `facturaAncla`, aplicando el total
    // de la distribución (200000 = 150000 + 50000).
    const aplicacionAncla = {
      _id: new Types.ObjectId(),
      documentoId: facturaAncla,
      tipoDocumento: 'FV',
      montoAplicado: 200000,
      estado: 'activa',
    };
    // La NO ancla: creada más tarde vía aplicar() contra OTRA factura, sin
    // relación con `nota.distribution`.
    const aplicacionOtra = {
      _id: new Types.ObjectId(),
      documentoId: facturaOtra,
      tipoDocumento: 'FV',
      montoAplicado: 80000,
      estado: 'activa',
    };

    const facturaAnclaRestaurada = {
      _id: facturaAncla,
      inmuebleId: INMUEBLE,
      total: 200000,
      lineas: [{ conceptoId: conceptoX, valorTotal: 200000 }],
    };
    const facturaOtraRestaurada = {
      _id: facturaOtra,
      inmuebleId: INMUEBLE,
      total: 80000,
      lineas: [{ conceptoId: conceptoZ, valorTotal: 80000 }],
    };

    const facturas = {
      // Resolves `desgloseOrigen`'s per-concepto débito accounts from the
      // anchor Factura's own `lines` — no `cuentaIngreso` set on
      // them here, so the reversal falls back to `cuentaDevoluciones`, which
      // this test doesn't assert on (it only checks the SaldoCartera math).
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () => {
            const id = filtro._id as Types.ObjectId;
            if (id.equals(facturaAncla)) {
              return Promise.resolve({ ...facturaAnclaRestaurada });
            }
            if (id.equals(facturaOtra)) {
              return Promise.resolve({ ...facturaOtraRestaurada });
            }
            return Promise.resolve(null);
          },
        }),
      })),
    };
    // `facturaOtra` was fully applied (80000/80000) before this void — the
    // restore brings its `SaldoTotalDocumento` row back from 0 to 80000,
    // which is what `ajustarSaldosCartera`'s reverse-cascade needs to derive
    // "how much of each line was pending before/after" correctly. The
    // anchor (`facturaAncla`) reverses via distribution math instead, so its
    // own pre-restore value here is never read.
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaAncla, saldoPendiente: 0 },
      { _id: facturaOtra, saldoPendiente: 0 },
    ]);
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve([aplicacionAncla, aplicacionOtra]),
        }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const llamadasSaldos: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadasSaldos.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.anular(
      nota._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Anula ambas aplicaciones, ancla y no-ancla',
        fecha: '2026-01-20',
      },
      'acc-1',
    );

    const extraerMonto = (conceptoId: Types.ObjectId) => {
      const llamada = llamadasSaldos.find(([f]) =>
        (f.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      const pipeline = llamada![1] as [
        {
          $set: {
            saldoPendiente: { $max: [number, { $add: [string, number] }] };
          };
        },
      ];
      return pipeline[0].$set.saldoPendiente.$max[1].$add[1];
    };

    // La ANCLA reversa por DISTRIBUCIÓN: una llamada por cada línea de
    // `nota.distribution`, cada una restaurando exactamente su propio monto.
    expect(
      llamadasSaldos.filter(([f]) => f.inmuebleId === INMUEBLE),
    ).toHaveLength(3);
    expect(extraerMonto(conceptoX)).toBe(150000);
    expect(extraerMonto(conceptoY)).toBe(50000);

    // La NO-ANCLA reversa por el split PROPORCIONAL de SU PROPIA factura —
    // una sola línea (conceptoZ), por el montoAplicado completo (80000) —
    // ajustarSaldosCartera sin cambios.
    expect(extraerMonto(conceptoZ)).toBe(80000);
  });

  it('postea SIEMPRE el contra-asiento, acreditando cuentaDevoluciones por el montoTotal completo', async () => {
    const nota = notaActivaDoc({
      montoAplicado: 200000,
      montoSinAplicar: 0,
      montoTotal: 200000,
    });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.anular(
      nota._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Detalle de más de veinte caracteres',
        fecha: '2026-01-20',
      },
      'acc-1',
    );

    // Cast to `jest.Mock` — same fix the `crear` tests above already needed
    // (line ~260): `modeloAsientos()`'s `create: jest.fn(() => ...)` has no
    // declared parameters, so TS infers `mock.calls` as `[][]`, and
    // destructuring a call's args as `[entrada]` fails to compile
    // (`Tuple type '[]' of length '0' has no element at index '0'`) even
    // though it runs fine under ts-jest. Fixed additively — the assertion
    // itself is unchanged.
    const [[creado]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const [entrada] = creado as unknown as [
      { movimientos: Record<string, unknown>[] },
    ];
    expect(entrada.movimientos.find((m) => m.tipo === 'credito')).toMatchObject(
      {
        cuenta: '413595',
        monto: 200000,
      },
    );
  });

  it('rechaza anular una nota crédito ya anulada', async () => {
    const nota = notaActivaDoc({ estado: 'anulado' });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await expect(
      service.anular(
        nota._id.toString(),
        {
          motivo: 'otro',
          detalle: 'Detalle de más de veinte caracteres',
          fecha: '2026-01-20',
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('NotasCreditoService.anular — ancla Nota Débito', () => {
  it('restaura el saldo de la Nota Débito ancla (nunca busca en facturas) y no revienta al reconstruir el débito por concepto', async () => {
    const notaDebitoId = new Types.ObjectId();
    const nota = notaActivaDoc({
      facturaId: null,
      notaDebitoId,
      tipoDocumentoAncla: 'ND',
      distribucion: [{ conceptoId: CONCEPTO, monto: 150000 }],
      montoTotal: 150000,
      montoAplicado: 150000,
      montoSinAplicar: 0,
    });
    const notaDebitoFrozen = {
      _id: notaDebitoId,
      inmuebleId: INMUEBLE,
      conceptoId: CONCEPTO,
      total: 150000,
      saldoPendiente: 0,
      descripcion: 'Multa por parqueo',
      numero: 1,
      numeroCompleto: 'ND-1',
    };
    const aplicacionAncla = {
      _id: new Types.ObjectId(),
      documentoId: notaDebitoId,
      tipoDocumento: 'ND',
      montoAplicado: 150000,
      estado: 'activa',
    };
    const facturas = {
      // Never consulted for an ND-anchored note — a call here (rather than
      // to `notasDebito`) would be the exact regression this test guards
      // against.
      findOne: jest.fn(() => {
        throw new Error('anular() no debe consultar facturas para un ancla ND');
      }),
    };
    const notasDebito = {
      findOne: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve({ ...notaDebitoFrozen }),
        }),
      })),
    };
    const conceptosCobro = {
      findOne: jest.fn(() => ({
        populate: () => ({
          populate: () => ({
            session: () => ({
              exec: () =>
                Promise.resolve({
                  _id: CONCEPTO,
                  nombre: 'Multa por parqueo',
                  tipo: 'otro',
                  cuentaCreditoId: { codigo: '413595' },
                  cuentaDebitoId: { codigo: '130505' },
                }),
            }),
          }),
        }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: notaDebitoId, saldoPendiente: 0 },
    ]);
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionAncla]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const saldoDocumentoOrigen = modeloSaldoDocumentoOrigen([
      {
        _id: nota._id,
        montoTotal: nota.montoTotal,
        montoSinAplicar: nota.montoSinAplicar,
      },
    ]);

    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      saldoDocumentoOrigen as never,
      notasDebito as never,
      conceptosCobro as never,
    );

    const resultado = await service.anular(
      nota._id.toString(),
      {
        motivo: 'error_facturacion',
        detalle: 'Nota crédito emitida por error, se anula',
        fecha: '2026-01-20',
      },
      'acc-1',
    );

    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalledWith(
      { documentoId: notaDebitoId },
      { $inc: { saldoPendiente: 150000 } },
      { returnDocument: 'after', session: expect.anything() as unknown },
    );
    expect(resultado.estado).toBe('anulado');
  });
});

describe('NotasCreditoService.findAll', () => {
  it('filtra por copropiedad activa, inmueble, estado y rango de fecha (issueDate, con fallback a createdAt para notas sin issueDate)', async () => {
    const documentos: unknown[] = [];
    const notasCredito = {
      find: jest.fn((filtro: Record<string, unknown>) => {
        (notasCredito as unknown as { filtroUsado: unknown }).filtroUsado =
          filtro;
        return {
          sort: () => ({
            skip: () => ({
              limit: () => ({ exec: () => Promise.resolve(documentos) }),
            }),
          }),
        };
      }),
      countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(0) })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.findAll({
      inmuebleId: INMUEBLE.toString(),
      estado: 'activo',
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });

    const rango = {
      $gte: new Date('2026-08-01'),
      $lte: new Date('2026-08-31'),
    };
    expect(
      (notasCredito as unknown as { filtroUsado: Record<string, unknown> })
        .filtroUsado,
    ).toEqual({
      copropiedadId: COP,
      inmuebleId: INMUEBLE.toString(),
      estado: 'activo',
      $or: [{ fecha: rango }, { fecha: null, createdAt: rango }],
    });
  });

  it('aplica conAnticipoDisponible resolviendo candidatos desde SaldoDocumentoOrigen', async () => {
    const documentos: unknown[] = [];
    const notaConAnticipo = {
      _id: new Types.ObjectId(),
      montoSinAplicar: 50000,
    };
    const notasCredito = {
      find: jest.fn((filtro: Record<string, unknown>) => {
        (notasCredito as unknown as { filtroUsado: unknown }).filtroUsado =
          filtro;
        return {
          sort: () => ({
            skip: () => ({
              limit: () => ({ exec: () => Promise.resolve(documentos) }),
            }),
          }),
        };
      }),
      countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(0) })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([notaConAnticipo]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await service.findAll({ conAnticipoDisponible: true });

    expect(
      (notasCredito as unknown as { filtroUsado: Record<string, unknown> })
        .filtroUsado,
    ).toMatchObject({ _id: { $in: [notaConAnticipo._id] } });
  });
});

describe('NotasCreditoService.findOne', () => {
  it('devuelve NotaCreditoDetalle con el arreglo de aplicaciones', async () => {
    const nota = notaActivaDoc();
    const notasCredito = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(nota) })),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([]) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    const detalle = await service.findOne(nota._id.toString());

    expect(detalle.id).toBe(nota._id.toString());
    expect(detalle.aplicaciones).toEqual([]);
  });

  it('resuelve numeroFactura de la ancla y de cada aplicación, aun cuando aplicó contra OTRA factura', async () => {
    // El excedente de una nota crédito puede aplicarse después contra
    // cualquier factura abierta del inmueble, no solo la ancla — igual que
    // el anticipo de un Recibo (ver `aplicarManual`/`aplicarFifo`). El mapa
    // de números debe resolver ambas, no solo `nota.facturaId`.
    const facturaAncla = new Types.ObjectId();
    const facturaOtra = new Types.ObjectId();
    const nota = notaActivaDoc({ facturaId: facturaAncla });
    const notasCredito = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(nota) })),
    };
    const aplicacion = {
      _id: new Types.ObjectId(),
      sourceType: 'NC',
      sourceId: nota._id,
      tipoDocumento: 'FV',
      documentoId: facturaOtra,
      montoAplicado: 50000,
      estado: 'activa',
      appliedAt: new Date('2026-08-30'),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([aplicacion]) }),
      })),
    };
    const facturas = {
      find: jest.fn(() => ({
        exec: () =>
          Promise.resolve([
            { _id: facturaAncla, numeroCompleto: 'FV-0001' },
            { _id: facturaOtra, numeroCompleto: 'FV-0042' },
          ]),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    const detalle = await service.findOne(nota._id.toString());

    expect(detalle.numeroDocumentoAncla).toBe('FV-0001');
    expect(detalle.aplicaciones[0]).toMatchObject({
      documentoId: facturaOtra.toString(),
      numeroDocumento: 'FV-0042',
    });
  });

  it('lanza NotFoundException cuando la nota crédito no existe bajo este tenant', async () => {
    const notasCredito = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
      modeloNotaDebitoVacio() as never,
      modeloConceptoCobroVacio() as never,
    );

    await expect(service.findOne('nc-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
