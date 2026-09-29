import { Types } from 'mongoose';
import {
  aplicarFifoEnMemoria,
  validarFilaAplicacionLote,
  type DatosBatchAplicacionLote,
  type DatosInmuebleParaAplicacionLote,
} from './aplicacion-lote-batch.util';

const INMUEBLE_ID = new Types.ObjectId();

const datosBase = (
  over: Partial<DatosBatchAplicacionLote> = {},
): DatosBatchAplicacionLote => ({
  indicePorInmueble: new Map([
    [
      INMUEBLE_ID.toString(),
      {
        inmueble: { _id: INMUEBLE_ID, holderId: new Types.ObjectId(), code: '301' },
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
    expect((resultado as { mensaje: string }).mensaje).toMatch(/06\/2026 está cerrado/);
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

const inmuebleDatos = (
  candidatosOrdenados: DatosInmuebleParaAplicacionLote['candidatosOrdenados'],
  saldos: Record<string, number>,
): DatosInmuebleParaAplicacionLote => ({
  inmueble: { _id: new Types.ObjectId(), holderId: new Types.ObjectId(), code: '301' },
  candidatosOrdenados,
  saldoPorDocumento: new Map(Object.entries(saldos)),
});

const facturaCandidato = (over: Record<string, unknown> = {}) => {
  const conceptoId = new Types.ObjectId();
  return {
    tipo: 'FV' as const,
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

    const resultado = aplicarFifoEnMemoria(datos, 250000, new Date('2026-06-02'), false);

    expect(resultado.aplicaciones).toHaveLength(0);
    expect(resultado.montoSinAplicar).toBe(250000);
    expect(resultado.resumen).toHaveLength(0);
  });

  it('aplica de a una factura, oldest-first, y marca completa cuando el saldo llega a cero', () => {
    const candidato = facturaCandidato();
    const datos = inmuebleDatos([candidato], {
      [candidato.doc._id.toString()]: 100000,
    });

    const resultado = aplicarFifoEnMemoria(datos, 100000, new Date('2026-06-02'), false);

    expect(resultado.montoSinAplicar).toBe(0);
    expect(resultado.aplicaciones).toHaveLength(1);
    expect(resultado.aplicaciones[0].montoAplicado).toBe(100000);
    expect(resultado.resumen[0]).toEqual({ tipo: 'FV', numero: 1, completa: true });
    expect(datos.saldoPorDocumento.get(candidato.doc._id.toString())).toBe(0);
  });

  it('C1 (Review Focus) — dos filas del mismo tanda contra la MISMA factura: la segunda ve el saldo ya consumido por la primera', () => {
    const candidato = facturaCandidato({ total: 100000 });
    const datos = inmuebleDatos([candidato], {
      [candidato.doc._id.toString()]: 100000,
    });

    const primeraFila = aplicarFifoEnMemoria(datos, 60000, new Date('2026-06-02'), false);
    const segundaFila = aplicarFifoEnMemoria(datos, 60000, new Date('2026-06-02'), false);

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

    const resultado = aplicarFifoEnMemoria(datos, 95000, new Date('2026-06-02'), false);

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

    const resultado = aplicarFifoEnMemoria(datos, 120000, new Date('2026-06-02'), false);

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
      },
    };
    const datos = inmuebleDatos([candidato], { [notaDebitoId.toString()]: 30000 });

    const resultado = aplicarFifoEnMemoria(datos, 30000, new Date('2026-06-02'), false);

    expect(resultado.aplicaciones[0]).toMatchObject({
      tipo: 'ND',
      montoAplicado: 30000,
      discountApplied: 0,
    });
    expect(resultado.resumen[0]).toEqual({ tipo: 'ND', numero: 7, completa: true });
  });
});
