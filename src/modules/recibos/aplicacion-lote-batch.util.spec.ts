import { Types } from 'mongoose';
import {
  aplicarFifoEnMemoria,
  construirEscrituraFilaAplicacion,
  procesarFilasTandaAplicacionLote,
  validarFilaAplicacionLote,
  type DatosBatchAplicacionLote,
  type DatosInmuebleParaAplicacionLote,
  type ResultadoFifoEnMemoria,
} from './aplicacion-lote-batch.util';
import type { LoteRecibosFila } from '../../database/schemas/recibos/lote-recibos.schema';

const INMUEBLE_ID = new Types.ObjectId();

const datosBase = (
  over: Partial<DatosBatchAplicacionLote> = {},
): DatosBatchAplicacionLote => ({
  indicePorInmueble: new Map([
    [
      INMUEBLE_ID.toString(),
      {
        inmueble: {
          _id: INMUEBLE_ID,
          holderId: new Types.ObjectId(),
          code: '301',
        },
        candidatosOrdenados: [],
        saldoPorDocumento: new Map(),
      },
    ],
  ]),
  copropiedad: null,
  cuentasContablesPorCodigo: new Map(),
  periodoAbiertoPorMes: new Map([['2026-06', true]]),
  ultimoLoteFacturacion: null,
  ...over,
});

const filaBase = (over: Record<string, unknown> = {}) => ({
  inmuebleId: INMUEBLE_ID,
  inmuebleCodigo: '301',
  fechaPago: new Date('2026-06-02'),
  ...over,
});

describe('validarFilaAplicacionLote', () => {
  it('es válida cuando el inmueble está en el índice, el período está abierto y cae en el período de facturación actual', () => {
    const resultado = validarFilaAplicacionLote(filaBase(), datosBase());
    expect(resultado).toEqual({ valido: true });
  });

  it('rechaza un inmueble que no está en el índice batch (ya no tiene titular, o no se resolvió)', () => {
    const resultado = validarFilaAplicacionLote(
      filaBase({ inmuebleId: new Types.ObjectId(), inmuebleCodigo: '999' }),
      datosBase(),
    );
    expect(resultado.valido).toBe(false);
    expect((resultado as { mensaje: string }).mensaje).toMatch(/titular/);
  });

  it('rechaza cuando el período contable del mes de la fila está cerrado', () => {
    const resultado = validarFilaAplicacionLote(
      filaBase(),
      datosBase({ periodoAbiertoPorMes: new Map([['2026-06', false]]) }),
    );
    expect(resultado.valido).toBe(false);
    expect((resultado as { mensaje: string }).mensaje).toMatch(
      /06\/2026 está cerrado/,
    );
  });

  it('cada fila se valida contra el período abierto de SU PROPIO mes en un lote con varios meses', () => {
    const datos = datosBase({
      periodoAbiertoPorMes: new Map([
        ['2026-06', true],
        ['2026-07', false],
      ]),
    });

    const filaJunio = validarFilaAplicacionLote(
      // Local-time Date constructor (year, monthIndex, day), not an ISO
      // string — `claveMesDe`/`periodoDe` read LOCAL getters on purpose
      // (see their own docblock), and this repo runs in America/Bogota
      // (UTC-5): `new Date('2026-07-01')` parses as UTC midnight, which
      // reads back as June 30 local, silently rolling into the WRONG
      // month. Same convention `periodo.service.spec.ts` already uses.
      filaBase({ fechaPago: new Date(2026, 5, 15) }),
      datos,
    );
    const filaJulio = validarFilaAplicacionLote(
      filaBase({ fechaPago: new Date(2026, 6, 1) }),
      datos,
    );

    expect(filaJunio.valido).toBe(true);
    expect(filaJulio.valido).toBe(false);
  });

  it('rechaza una fecha de pago fuera del período de facturación actual', () => {
    const resultado = validarFilaAplicacionLote(
      filaBase({ fechaPago: new Date('2026-05-01') }),
      datosBase({
        ultimoLoteFacturacion: {
          periodStart: new Date('2026-06-01'),
          periodEnd: new Date('2026-06-30'),
        },
      }),
    );
    expect(resultado.valido).toBe(false);
    expect((resultado as { mensaje: string }).mensaje).toMatch(
      /período de facturación actual/,
    );
  });

  it('no valida contra período de facturación cuando la copropiedad nunca ha consolidado un lote', () => {
    const resultado = validarFilaAplicacionLote(
      filaBase(),
      datosBase({ ultimoLoteFacturacion: null }),
    );
    expect(resultado.valido).toBe(true);
  });
});

/** `candidatosOrdenados` is typed loosely (never the strict Mongoose
 *  document union) on purpose — every caller below hand-rolls plain
 *  object doc fixtures (not real Mongoose documents), and casting each one
 *  individually would fight `.doc._id`-style direct property access in
 *  the same test. `as never` here is the single place that trade-off is
 *  made, matching this repo's own convention for hand-rolled mocks. */
const inmuebleDatos = (
  candidatosOrdenados: { tipo: string; doc: Record<string, unknown> }[],
  saldos: Record<string, number>,
): DatosInmuebleParaAplicacionLote => ({
  inmueble: {
    _id: new Types.ObjectId(),
    holderId: new Types.ObjectId(),
    code: '301',
  },
  candidatosOrdenados: candidatosOrdenados as never,
  saldoPorDocumento: new Map(Object.entries(saldos)),
});

const facturaCandidato = (over: Record<string, unknown> = {}) => {
  const conceptoId = new Types.ObjectId();
  return {
    tipo: 'FV' as const,
    // Plain object, not a real Mongoose FacturaDocument — `as never`, same
    // cast this file's other hand-rolled candidate fixtures already use
    // (see the Nota Débito candidate below), since a hand-rolled test
    // double can never structurally satisfy Mongoose's real Document type.
    doc: {
      _id: new Types.ObjectId(),
      inmuebleId: new Types.ObjectId(),
      number: 1,
      total: 100000,
      discountAmount: 0,
      discountDeadline: null,
      dueDate: new Date('2026-05-10'),
      issueDate: new Date('2026-05-01'),
      lines: [
        {
          conceptoId,
          conceptName: 'Administración',
          conceptKind: 'administracion',
          accountingReceivableAccount: '130505',
          accountingIncomeAccount: '413505',
          totalAmount: 100000,
        },
      ],
      ...over,
    },
  };
};

describe('aplicarFifoEnMemoria', () => {
  it('deja el monto completo como anticipo cuando el inmueble no tiene documentos abiertos (pura anticipo)', () => {
    const datos = inmuebleDatos([], {});

    const resultado = aplicarFifoEnMemoria(
      datos,
      250000,
      new Date('2026-06-02'),
      false,
    );

    expect(resultado.aplicaciones).toHaveLength(0);
    expect(resultado.montoSinAplicar).toBe(250000);
    expect(resultado.resumen).toHaveLength(0);
  });

  it('aplica de a una factura, oldest-first, y marca completa cuando el saldo llega a cero', () => {
    const candidato = facturaCandidato();
    const datos = inmuebleDatos([candidato], {
      [candidato.doc._id.toString()]: 100000,
    });

    const resultado = aplicarFifoEnMemoria(
      datos,
      100000,
      new Date('2026-06-02'),
      false,
    );

    expect(resultado.montoSinAplicar).toBe(0);
    expect(resultado.aplicaciones).toHaveLength(1);
    expect(resultado.aplicaciones[0].montoAplicado).toBe(100000);
    expect(resultado.resumen[0]).toEqual({
      tipo: 'FV',
      numero: 1,
      completa: true,
    });
    expect(datos.saldoPorDocumento.get(candidato.doc._id.toString())).toBe(0);
  });

  it('C1 (Review Focus) — dos filas del mismo tanda contra la MISMA factura: la segunda ve el saldo ya consumido por la primera', () => {
    const candidato = facturaCandidato({ total: 100000 });
    const datos = inmuebleDatos([candidato], {
      [candidato.doc._id.toString()]: 100000,
    });

    const primeraFila = aplicarFifoEnMemoria(
      datos,
      60000,
      new Date('2026-06-02'),
      false,
    );
    const segundaFila = aplicarFifoEnMemoria(
      datos,
      60000,
      new Date('2026-06-02'),
      false,
    );

    expect(primeraFila.aplicaciones[0].montoAplicado).toBe(60000);
    // Solo quedaban 40000 quando corrió la segunda fila.
    expect(segundaFila.aplicaciones[0].montoAplicado).toBe(40000);
    expect(segundaFila.montoSinAplicar).toBe(20000);
    expect(datos.saldoPorDocumento.get(candidato.doc._id.toString())).toBe(0);
  });

  it('activa el descuento por pronto pago solo cuando el pago cancela la factura completa dentro del plazo', () => {
    const candidato = facturaCandidato({
      total: 100000,
      discountAmount: 5000,
      discountDeadline: new Date('2026-06-10'),
    });
    const datos = inmuebleDatos([candidato], {
      [candidato.doc._id.toString()]: 100000,
    });

    const resultado = aplicarFifoEnMemoria(
      datos,
      95000,
      new Date('2026-06-02'),
      false,
    );

    expect(resultado.aplicaciones[0].montoAplicado).toBe(100000);
    expect(resultado.aplicaciones[0].discountApplied).toBe(5000);
    expect(resultado.montoDescuentoTotal).toBe(5000);
    expect(resultado.montoSinAplicar).toBe(0);
  });

  it('acumula montoAplicadoMora solo por las partes de líneas conceptKind intereses', () => {
    const conceptoMora = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const candidato = facturaCandidato({
      total: 120000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          conceptName: 'Administración',
          conceptKind: 'administracion',
          accountingReceivableAccount: '130505',
          accountingIncomeAccount: '413505',
          totalAmount: 100000,
        },
        {
          conceptoId: conceptoMora,
          conceptName: 'Intereses de mora',
          conceptKind: 'intereses',
          accountingReceivableAccount: '130510',
          accountingIncomeAccount: '413510',
          totalAmount: 20000,
        },
      ],
    });
    const datos = inmuebleDatos([candidato], {
      [candidato.doc._id.toString()]: 120000,
    });

    const resultado = aplicarFifoEnMemoria(
      datos,
      120000,
      new Date('2026-06-02'),
      false,
    );

    // Orden inverso: la línea de intereses (última en `lines`) se llena
    // primero — ver el docblock de `calcularPartesWaterfall`.
    expect(resultado.montoAplicadoMora).toBe(20000);
  });

  it('una Nota Débito usa el reparto de una sola línea, nunca la cascada de waterfall', () => {
    const conceptoId = new Types.ObjectId();
    const notaDebitoId = new Types.ObjectId();
    const candidato = {
      tipo: 'ND' as const,
      doc: {
        _id: notaDebitoId,
        inmuebleId: new Types.ObjectId(),
        number: 7,
        total: 30000,
        conceptoId,
        description: 'Multa por parqueadero',
        issueDate: new Date('2026-05-05'),
      } as never, // not a real NotaDebitoDocument — same reasoning as facturaCandidato's own cast
    };
    const datos = inmuebleDatos([candidato], {
      [notaDebitoId.toString()]: 30000,
    });

    const resultado = aplicarFifoEnMemoria(
      datos,
      30000,
      new Date('2026-06-02'),
      false,
    );

    expect(resultado.aplicaciones[0]).toMatchObject({
      tipo: 'ND',
      montoAplicado: 30000,
      discountApplied: 0,
    });
    expect(resultado.resumen[0]).toEqual({
      tipo: 'ND',
      numero: 7,
      completa: true,
    });
  });
});

const resultadoFifoBase = (
  over: Partial<ResultadoFifoEnMemoria> = {},
): ResultadoFifoEnMemoria => ({
  aplicaciones: [],
  desglose: [],
  montoAplicadoMora: 0,
  montoDescuentoTotal: 0,
  resumen: [],
  montoSinAplicar: 0,
  ...over,
});

const ctxBase = () => ({
  coPropertyId: new Types.ObjectId(),
  accountId: 'cuenta-1',
  fila: { valorRecibido: 100000, fechaPago: new Date('2026-06-02') },
  numero: { prefijo: 'RC', numero: 1, completo: 'RC-1' },
  medioPago: 'transferencia' as const,
  destinationAccount: '111005',
  datosInmueble: {
    inmueble: {
      _id: new Types.ObjectId(),
      holderId: new Types.ObjectId(),
      code: '301',
    },
    candidatosOrdenados: [],
    saldoPorDocumento: new Map(),
  },
  copropiedad: null,
  cuentasContablesPorCodigo: new Map(),
});

describe('construirEscrituraFilaAplicacion', () => {
  it('anticipo puro (sin aplicaciones): notes dice "Genera anticipo", saldoDocumentoOrigen queda con el total', () => {
    const escritura = construirEscrituraFilaAplicacion({
      ...ctxBase(),
      resultadoFifo: resultadoFifoBase({ montoSinAplicar: 100000 }),
    });

    expect(escritura.recibo.notes).toBe('Genera anticipo');
    expect(escritura.saldoDocumentoOrigen.saldoDisponible).toBe(100000);
    expect(escritura.aplicacionesCartera).toHaveLength(0);
  });

  it('cancela completo una factura: notes dice "Cancela factura N", sin anticipo', () => {
    const escritura = construirEscrituraFilaAplicacion({
      ...ctxBase(),
      resultadoFifo: resultadoFifoBase({
        resumen: [{ tipo: 'FV', numero: 42, completa: true }],
        // `aplicaciones` debe ser consistente con `resumen`/`montoSinAplicar`
        // — la nota se deriva de `resumen`, pero `sobrante` se deriva de
        // `aplicaciones` (mismo patrón que `crearEnSesion` original, que
        // tampoco confía en `montoSinAplicar` directo — ver ledger de esta
        // tarea). Un `aplicaciones` vacío con `montoSinAplicar: 0` fabricado
        // aparte es un fixture inconsistente, no un caso real.
        aplicaciones: [
          {
            tipo: 'FV',
            documentId: new Types.ObjectId(),
            numeroDocumento: 42,
            montoAplicado: 100000,
            discountApplied: 0,
            detalleConceptos: [],
            saldoTotalDocumentoDelta: -100000,
            saldoCarteraDeltas: [],
            carteraPorDocumentoDeltas: [],
          },
        ],
        montoSinAplicar: 0,
      }),
    });

    expect(escritura.recibo.notes).toBe('Cancela factura 42');
    expect(escritura.saldoDocumentoOrigen.saldoDisponible).toBe(0);
  });

  it('abona parcialmente una factura (no la completa): notes dice "Abona a factura N"', () => {
    const escritura = construirEscrituraFilaAplicacion({
      ...ctxBase(),
      resultadoFifo: resultadoFifoBase({
        resumen: [{ tipo: 'FV', numero: 42, completa: false }],
        aplicaciones: [
          {
            tipo: 'FV',
            documentId: new Types.ObjectId(),
            numeroDocumento: 42,
            montoAplicado: 100000,
            discountApplied: 0,
            detalleConceptos: [],
            saldoTotalDocumentoDelta: -100000,
            saldoCarteraDeltas: [],
            carteraPorDocumentoDeltas: [],
          },
        ],
        montoSinAplicar: 0,
      }),
    });

    expect(escritura.recibo.notes).toBe('Abona a factura 42');
  });

  it('un descuento por pronto pago que cancela la factura: notes sigue diciendo "Cancela", y el asiento incluye la línea de descuento', () => {
    const escritura = construirEscrituraFilaAplicacion({
      ...ctxBase(),
      // 100000 de factura menos 5000 de descuento = 95000 de cash real
      // necesario — el recibo debe traer EXACTAMENTE eso, o el sobrante
      // (100000 - 95000) generaría anticipo real, no un fixture roto.
      fila: { valorRecibido: 95000, fechaPago: new Date('2026-06-02') },
      copropiedad: {
        receivablesAccount: '130505',
        advancesAccount: '280505',
        discountsDebitAccount: '530505',
        usesMemorandumAccounts: false,
        memorandumDebitAccount: null,
        memorandumCreditAccount: null,
        defaultCostCentre: null,
        cashFlowCode: null,
        defaultBankAccountCode: null,
      },
      resultadoFifo: resultadoFifoBase({
        resumen: [{ tipo: 'FV', numero: 42, completa: true }],
        montoDescuentoTotal: 5000,
        aplicaciones: [
          {
            tipo: 'FV',
            documentId: new Types.ObjectId(),
            numeroDocumento: 42,
            montoAplicado: 100000,
            discountApplied: 5000,
            detalleConceptos: [],
            saldoTotalDocumentoDelta: -100000,
            saldoCarteraDeltas: [],
            carteraPorDocumentoDeltas: [],
          },
        ],
        montoSinAplicar: 0,
      }),
    });

    expect(escritura.recibo.notes).toBe('Cancela factura 42');
    expect(
      (escritura.asientoContable.entries as { account: string }[]).some(
        (m) => m.account === '530505',
      ),
    ).toBe(true);
  });

  it('el Recibo, SaldoDocumentoOrigen y AsientoContable comparten el mismo reciboId pre-generado', () => {
    const escritura = construirEscrituraFilaAplicacion({
      ...ctxBase(),
      resultadoFifo: resultadoFifoBase({ montoSinAplicar: 100000 }),
    });

    expect(escritura.saldoDocumentoOrigen.documentoId).toBe(escritura.reciboId);
    expect(escritura.asientoContable.reciboId).toBe(escritura.reciboId);
  });
});

const filaTanda = (
  over: Partial<LoteRecibosFila> = {},
): {
  fila: LoteRecibosFila;
  indice: number;
  numero: { prefijo: string; numero: number; completo: string };
} => ({
  fila: {
    inmuebleId: new Types.ObjectId(),
    inmuebleCodigo: '301',
    fechaPago: new Date('2026-06-02'),
    valorRecibido: 100000,
    reciboId: null,
    error: null,
    ...over,
  } as LoteRecibosFila,
  indice: 0,
  numero: { prefijo: 'RC', numero: 1, completo: 'RC-1' },
});

const datosParaInmueble = (
  inmuebleId: Types.ObjectId,
): DatosBatchAplicacionLote => ({
  indicePorInmueble: new Map([
    [
      inmuebleId.toString(),
      {
        inmueble: {
          _id: inmuebleId,
          holderId: new Types.ObjectId(),
          code: '301',
        },
        candidatosOrdenados: [],
        saldoPorDocumento: new Map(),
      },
    ],
  ]),
  copropiedad: null,
  cuentasContablesPorCodigo: new Map(),
  periodoAbiertoPorMes: new Map(),
  ultimoLoteFacturacion: null,
});

const ctxTanda = () => ({
  coPropertyId: new Types.ObjectId(),
  accountId: 'cuenta-1',
  medioPago: 'transferencia' as const,
  destinationAccount: '111005',
});

describe('procesarFilasTandaAplicacionLote', () => {
  it('todas las filas válidas: produce una escritura por fila, cada una con su propio reciboId', () => {
    const inmuebleA = new Types.ObjectId();
    const inmuebleB = new Types.ObjectId();
    const datos: DatosBatchAplicacionLote = {
      ...datosParaInmueble(inmuebleA),
      periodoAbiertoPorMes: new Map([['2026-06', true]]),
    };
    datos.indicePorInmueble.set(inmuebleB.toString(), {
      inmueble: { _id: inmuebleB, holderId: new Types.ObjectId(), code: '302' },
      candidatosOrdenados: [],
      saldoPorDocumento: new Map(),
    });

    const filas = [
      filaTanda({ inmuebleId: inmuebleA }),
      { ...filaTanda({ inmuebleId: inmuebleB }), indice: 1 },
    ];

    const resultado = procesarFilasTandaAplicacionLote(
      filas,
      datos,
      ctxTanda(),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) throw new Error('expected ok');
    expect(resultado.escrituras).toHaveLength(2);
    expect(resultado.escrituras[0].reciboId).not.toEqual(
      resultado.escrituras[1].reciboId,
    );
  });

  it('una fila inválida anula TODA la tanda con el mismo mensaje-colateral que produce hoy procesarTanda', () => {
    const inmuebleA = new Types.ObjectId();
    const datos = {
      ...datosParaInmueble(inmuebleA),
      periodoAbiertoPorMes: new Map([['2026-06', false]]), // mes cerrado
    };
    const filas = [
      filaTanda({ inmuebleId: inmuebleA }),
      { ...filaTanda({ inmuebleId: inmuebleA }), indice: 1 },
    ];

    const resultado = procesarFilasTandaAplicacionLote(
      filas,
      datos,
      ctxTanda(),
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) throw new Error('expected error');
    expect(resultado.erroresPorIndice.get(0)).toMatch(/06\/2026 está cerrado/);
    expect(resultado.erroresPorIndice.get(1)).toMatch(
      /Revertida junto con la fila 1, que falló/,
    );
  });

  it('dos filas del mismo tanda contra el mismo inmueble comparten y consumen el mismo saldoPorDocumento', () => {
    const inmuebleA = new Types.ObjectId();
    const documentoId = new Types.ObjectId();
    const datos: DatosBatchAplicacionLote = {
      indicePorInmueble: new Map([
        [
          inmuebleA.toString(),
          {
            inmueble: {
              _id: inmuebleA,
              holderId: new Types.ObjectId(),
              code: '301',
            },
            candidatosOrdenados: [
              {
                tipo: 'FV',
                doc: {
                  _id: documentoId,
                  inmuebleId: inmuebleA,
                  number: 42,
                  total: 150000,
                  discountAmount: 0,
                  discountDeadline: null,
                  dueDate: new Date('2026-05-10'),
                  issueDate: new Date('2026-05-01'),
                  lines: [
                    {
                      conceptoId: new Types.ObjectId(),
                      conceptName: 'Administración',
                      conceptKind: 'administracion',
                      accountingReceivableAccount: '130505',
                      accountingIncomeAccount: '413505',
                      totalAmount: 150000,
                    },
                  ],
                } as never,
              },
            ],
            saldoPorDocumento: new Map([[documentoId.toString(), 150000]]),
          },
        ],
      ]),
      copropiedad: null,
      cuentasContablesPorCodigo: new Map(),
      periodoAbiertoPorMes: new Map([['2026-06', true]]),
      ultimoLoteFacturacion: null,
    };

    const filas = [
      filaTanda({ inmuebleId: inmuebleA, valorRecibido: 90000 }),
      {
        ...filaTanda({ inmuebleId: inmuebleA, valorRecibido: 90000 }),
        indice: 1,
      },
    ];

    const resultado = procesarFilasTandaAplicacionLote(
      filas,
      datos,
      ctxTanda(),
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) throw new Error('expected ok');
    // 150000 repartidos entre dos pagos de 90000: la primera fila aplica
    // 90000, la segunda solo puede aplicar los 60000 que quedan.
    expect(resultado.escrituras[0].saldoTotalDocumentoDeltas[0].delta).toBe(
      -90000,
    );
    expect(resultado.escrituras[1].saldoTotalDocumentoDeltas[0].delta).toBe(
      -60000,
    );
  });
});
