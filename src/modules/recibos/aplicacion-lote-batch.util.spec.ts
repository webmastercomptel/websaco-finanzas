import { Types } from 'mongoose';
import {
  validarFilaAplicacionLote,
  type DatosBatchAplicacionLote,
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
